const instagramDownloader = require('./instagram-downloader');
const path = require('path');
const fs = require('fs');
const os = require('os');

function extractShortcode(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/(reel|reels|p)\/([A-Za-z0-9_-]+)/);
  return m ? m[2] : null;
}

function extractShortcodeFromXma(xmaData) {
  const items = Array.isArray(xmaData) ? xmaData : [xmaData];
  for (const xma of items) {
    if (!xma || typeof xma !== 'object') continue;
    const sc = extractShortcode(xma.target_url)
      || extractShortcode(xma.url)
      || extractShortcode(xma.preview_url);
    if (sc) return sc;
  }
  return null;
}

/**
 * Resolves a shared carousel from the DM thread where it was shared.
 */
async function resolveCarouselFromThread(senderUsername, captionSnippet, downloadDir) {
  if (!senderUsername || senderUsername.startsWith('user_')) return null;

  await instagramDownloader.login();
  const ig = instagramDownloader.ig;

  let threadId = null;

  try {
    const senderPk = await ig.user.getIdByUsername(senderUsername);
    const result = await ig.directThread.getByParticipants([[senderPk]]);
    threadId = result?.thread?.thread_id;
  } catch (err) {
    try {
      const inboxFeed = ig.feed.directInbox();
      const threads = await inboxFeed.items();
      const match = threads.find(t =>
        t.users?.some(u => u.username === senderUsername) ||
        t.thread_title === senderUsername
      );
      if (match) threadId = match.thread_id;
    } catch (inboxErr) {
      return null;
    }
  }

  if (!threadId) return null;

  let shortcode = null;
  try {
    const threadFeed = ig.feed.directThread({ thread_id: threadId });
    const items = await threadFeed.items();

    const snippet = (captionSnippet || '').slice(0, 50).toLowerCase();

    for (const item of items) {
      if (item.item_type === 'xma_media_share' && item.xma_media_share) {
        const sc = extractShortcodeFromXma(item.xma_media_share);
        if (sc) { shortcode = sc; break; }
      }

      if (item.item_type === 'generic_xma' && item.generic_xma) {
        const sc = extractShortcodeFromXma(item.generic_xma);
        if (sc) { shortcode = sc; break; }
      }

      if (item.item_type === 'media_share' && item.media_share) {
        const cap = (item.media_share.caption?.text || '').toLowerCase();
        if (!snippet || cap.includes(snippet.slice(0, 40))) {
          shortcode = item.media_share.code;
          if (shortcode) break;
        }
      }

      if (item.item_type === 'clip' && item.clip?.clip?.code) {
        shortcode = item.clip.clip.code;
        break;
      }
    }
  } catch (err) {
    return null;
  }

  if (!shortcode) return null;

  try {
    return await instagramDownloader.downloadMedia(
      `https://www.instagram.com/p/${shortcode}/`,
      downloadDir,
      'carousel'
    );
  } catch (err) {
    return null;
  }
}

module.exports = { resolveCarouselFromThread };
