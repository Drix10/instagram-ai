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
    if (!accessToken) {
      console.warn('[WEBHOOK] Skipping enabling subscriptions - missing INSTAGRAM_ACCESS_TOKEN');
      return false;
    }

    await axios({
      method: 'POST',
      url: `https://graph.instagram.com/v21.0/me/subscribed_apps`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      params: {
        subscribed_fields: 'messages,comments,mentions,story_insights'
      }
    });

    console.log('[WEBHOOK] Enabled page subscriptions on Meta');
    return true;
  } catch (error) {
    console.error('[WEBHOOK] Error enabling page subscriptions:', error);
    console.error(error.response?.data || error.message);
    return false;
  }
}

(async () => {
  try {
    await instagramClient.init();
    await enablePageSubscriptions();
  } catch (error) {
    console.error('[WEBHOOK] Failed during client startup subscriptions hook:', error);
  }
})();

function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedVerifyToken = process.env.INSTAGRAM_VERIFY_TOKEN;

  if (mode && token) {
    if (mode === 'subscribe' && token === expectedVerifyToken) {
      console.log('[WEBHOOK] Verification successful');
      res.status(200).send(challenge);
    } else {
      console.warn('[WEBHOOK] Verification failed: token mismatch');
      res.sendStatus(403);
    }
  } else {
    console.warn('[WEBHOOK] Invalid verification request: missing parameters');
    res.sendStatus(400);
  }
}

function validateSignature(req) {
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!appSecret) {
    return true;
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    console.warn('[WEBHOOK] No signature header found in request');
    return false;
  }

  try {
    const elements = signature.split('=');
    const signatureHash = elements[1];
    const rawBody = req.rawBody || '';

    const expectedHash = crypto
      .createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex');

    return signatureHash === expectedHash;
  } catch (error) {
    console.error('[WEBHOOK] Error validating signature:', error);
    return false;
  }
}

async function processWebhook(req, res) {
  res.status(200).send('EVENT_RECEIVED');

  try {
    if (!validateSignature(req)) {
      console.warn('[WEBHOOK] Invalid signature, discarding event');
      return;
    }

    const body = req.body;
    if (body.object !== 'instagram') {
      return;
    }

    if (!body.entry || !Array.isArray(body.entry)) {
      return;
    }

    for (const entry of body.entry) {
      if (entry.messaging && Array.isArray(entry.messaging)) {
        for (const messagingEvent of entry.messaging) {
          try {
            if (messagingEvent.message && messagingEvent.message.mid) {
              const mid = messagingEvent.message.mid;
              if (processedMidsSet.has(mid)) {
                console.log(`[WEBHOOK] Duplicate event for mid: ${mid}. Skipping.`);
                continue;
              }
              addProcessedMid(mid);
            }

            if (messagingEvent.message) {
              await handleMessage(messagingEvent);
            } else if (messagingEvent.postback) {
              await handlePostback(messagingEvent);
            }
          } catch (handlerError) {
            console.error('[WEBHOOK] Error handling messaging event:', handlerError);
          }
        }
      }
    }
  } catch (error) {
    console.error('[WEBHOOK] Error processing webhook:', error);
  }
}

async function handleMessage(event) {
  try {
    if (event.message && event.message.is_echo === true) {
      return;
    }

    const senderId = event.sender.id;
    const message = event.message;

    let username = 'instagram_user';
    try {
      const profileInfo = await instagramClient.getProfileInfo(senderId);
      if (profileInfo && profileInfo.username) {
        username = profileInfo.username;
      }
    } catch (profileError) {
      console.warn('[WEBHOOK] Could not fetch profile username:', profileError.message);
    }

    let reelUrl = null;
    if (message.attachments && Array.isArray(message.attachments)) {
      const shareAttachment = message.attachments.find(att => att.type === 'share');
      if (shareAttachment && shareAttachment.payload && shareAttachment.payload.url) {
        reelUrl = shareAttachment.payload.url;
      }
    }

    const normalizedMessage = {
      sender: {
        id: senderId,
        username: username,
      },
      text: message.text || '',
      timestamp: event.timestamp,
      messageId: message.mid,
      platform: 'instagram',
      reelUrl: reelUrl,
      is_echo: message.is_echo || false
    };

    await instagramClient.processMessage(normalizedMessage);
  } catch (error) {
    console.error('[WEBHOOK] Error handling message:', error);
  }
}

async function handlePostback(event) {
  try {
    const senderId = event.sender.id;
    const postback = event.postback;

    if (!postback || !postback.payload) {
      return;
    }

    let username = 'instagram_user';
    try {
      const profileInfo = await instagramClient.getProfileInfo(senderId);
      if (profileInfo && profileInfo.username) {
        username = profileInfo.username;
      }
    } catch (err) {
      console.warn('[WEBHOOK] Error getting profile info for postback:', err.message);
    }

    const normalizedMessage = {
      sender: {
        id: senderId,
        username: username
      },
      text: `${postback.payload}`,
      timestamp: event.timestamp,
      platform: 'instagram',
      isPostback: true,
      postbackRaw: postback
    };

    await instagramClient.processMessage(normalizedMessage);
  } catch (error) {
    console.error('[WEBHOOK] Error handling postback:', error);
  }
}

module.exports = {
  verifyWebhook,
  processWebhook,
  instagramClient,
  enablePageSubscriptions
};