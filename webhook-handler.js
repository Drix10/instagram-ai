const crypto = require('crypto');
const axios = require('axios');
const instagramClient = require('./instagram-client');

const processedMidsSet = new Set();
const processedMidsList = [];
const MAX_PROCESSED_MIDS = 1000;

function addProcessedMid(mid) {
  if (!mid) return;
  processedMidsSet.add(mid);
  processedMidsList.push(mid);
  if (processedMidsList.length > MAX_PROCESSED_MIDS) {
    const oldestMid = processedMidsList.shift();
    processedMidsSet.delete(oldestMid);
  }
}

async function enablePageSubscriptions() {
  try {
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
    if (!accessToken) return false;
    await axios({
      method: 'POST',
      url: `https://graph.instagram.com/v21.0/me/subscribed_apps`,
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      params: { subscribed_fields: 'messages,comments,mentions,story_insights' }
    });
    return true;
  } catch (error) {
    return false;
  }
}

function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedVerifyToken = process.env.INSTAGRAM_VERIFY_TOKEN;
  if (mode && token) {
    if (mode === 'subscribe' && token === expectedVerifyToken) res.status(200).send(challenge);
    else res.sendStatus(403);
  } else res.sendStatus(400);
}

function validateSignature(req) {
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!appSecret) return false;
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  try {
    const elements = signature.split('=');
    const signatureHash = elements[1];
    if (!signatureHash) return false;
    const rawBody = req.rawBody || '';
    const expectedHash = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signatureHash, 'hex');
    const expectedBuf = Buffer.from(expectedHash, 'hex');
    if (sigBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  } catch (error) {
    return false;
  }
}

async function processWebhook(req, res) {
  res.status(200).send('EVENT_RECEIVED');
  try {
    if (!validateSignature(req)) return;
    const body = req.body;
    if (body.object !== 'instagram') return;
    if (!body.entry || !Array.isArray(body.entry)) return;
    for (const entry of body.entry) {
      if (entry.messaging && Array.isArray(entry.messaging)) {
        for (const messagingEvent of entry.messaging) {
          try {
            if (messagingEvent.read || messagingEvent.delivery) continue;
            if (messagingEvent.message && messagingEvent.message.mid) {
              const mid = messagingEvent.message.mid;
              if (processedMidsSet.has(mid)) continue;
              addProcessedMid(mid);
            }
            if (messagingEvent.message) await handleMessage(messagingEvent);
            else if (messagingEvent.postback) await handlePostback(messagingEvent);
          } catch (handlerError) {}
        }
      }
    }
  } catch (error) {}
}

async function handleMessage(event) {
  try {
    if (event.message && event.message.is_echo === true) return;
    const senderId = event.sender.id;
    const message = event.message;
    let username = 'instagram_user';
    try {
      const profileInfo = await instagramClient.getProfileInfo(senderId);
      if (profileInfo && profileInfo.username) username = profileInfo.username;
    } catch (profileError) {}

    let reelUrl = null;
    let reelCaption = null;
    let needsCarouselResolution = false;
    let carouselPayload = null;

    if (message.share && message.share.link) reelUrl = message.share.link;

    if (message.attachments && Array.isArray(message.attachments)) {
      const mediaAttachments = message.attachments.filter(att => att.type === 'share' || att.type === 'ig_post' || att.type === 'ig_reel');
      if (mediaAttachments.length > 0) {
        const urls = mediaAttachments.map(att => {
          if (att.payload) {
            return {
              url: att.payload.share && att.payload.share.link ? att.payload.share.link : (att.payload.url || null),
              fallbackUrl: att.payload.url || null,
              mediaId: att.payload.ig_post_media_id || att.payload.ig_reel_media_id || null
            };
          }
          return null;
        }).filter(u => u && (u.url || u.fallbackUrl || u.mediaId));
        
        if (urls.length > 0) {
          if (!reelUrl) reelUrl = urls.length === 1 ? urls[0] : urls;
          else if (Array.isArray(reelUrl)) reelUrl.push(...urls);
          else reelUrl = [reelUrl, ...urls];
        }
        
        const titleAtt = mediaAttachments.find(att => att.payload && typeof att.payload.title === 'string' && att.payload.title.trim().length > 0);
        if (titleAtt) reelCaption = titleAtt.payload.title;

        const igPostAttachment = mediaAttachments.find(att => att.type === 'ig_post' || att.type === 'ig_reel');
        if (igPostAttachment && reelCaption) {
          needsCarouselResolution = true;
          carouselPayload = igPostAttachment.payload;
        }
      }
    }

    const normalizedMessage = {
      sender: { id: senderId, username: username },
      text: message.text || '',
      timestamp: event.timestamp,
      messageId: message.mid,
      platform: 'instagram',
      reelUrl: reelUrl,
      reelCaption: reelCaption,
      needsCarouselResolution: needsCarouselResolution,
      carouselPayload: carouselPayload,
      is_echo: message.is_echo || false
    };
    await instagramClient.processMessage(normalizedMessage);
  } catch (error) {}
}

async function handlePostback(event) {
  try {
    const senderId = event.sender.id;
    const postback = event.postback;
    if (!postback || !postback.payload) return;
    let username = 'instagram_user';
    try {
      const profileInfo = await instagramClient.getProfileInfo(senderId);
      if (profileInfo && profileInfo.username) username = profileInfo.username;
    } catch (err) {}
    const normalizedMessage = {
      sender: { id: senderId, username: username },
      text: `${postback.payload}`,
      timestamp: event.timestamp,
      platform: 'instagram',
      isPostback: true,
      postbackRaw: postback
    };
    await instagramClient.processMessage(normalizedMessage);
  } catch (error) {}
}

module.exports = { verifyWebhook, processWebhook, instagramClient, enablePageSubscriptions };
