class RateLimiter {
  constructor(bufferPercentage = 10) {
    this.bufferPercentage = bufferPercentage;
    this.resetRateLimits();
    this.userRateLimits = new Map();
    this.lastRateLimitHit = 0;

    this.cleanupInterval = setInterval(() => {
      this.cleanupOldEntries(Date.now());
    }, 60 * 1000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  resetRateLimits() {
    this.callCount = 0;
    this.callPercent = 0;
    this.lastReset = Date.now();
  }

  updateFromHeaders(appUsage) {
    if (!appUsage) return;

    try {
      if (typeof appUsage === 'string') {
        appUsage = JSON.parse(appUsage);
      }

      if (appUsage.call_count !== undefined) {
        this.callCount = appUsage.call_count;
      }

      if (appUsage.call_volume !== undefined) {
        this.callPercent = appUsage.call_volume;
      } else if (appUsage.total_cputime !== undefined) {
        this.callPercent = appUsage.total_cputime;
      } else if (appUsage.total_time !== undefined) {
        this.callPercent = appUsage.total_time;
      }
    } catch (error) {
      console.error('[RATE LIMITER] Error parsing usage headers:', error);
    }
  }

  markRateLimited() {
    this.lastRateLimitHit = Date.now();
    this.callPercent = 90;
    console.log(`[RATE LIMITER] Hit rate limit, cooling down for 15 minutes`);
  }

  canSendMessage() {
    if (Date.now() - this.lastRateLimitHit < 15 * 60 * 1000) {
      return false;
    }

    if (Date.now() - this.lastReset > 60 * 60 * 1000) {
      this.resetRateLimits();
    }

    return this.callPercent < (100 - this.bufferPercentage);
  }

  canProcess(userId) {
    const now = Date.now();

    if (this.userRateLimits.has(userId)) {
      const userData = this.userRateLimits.get(userId);

      if (userData.count >= 10 && now - userData.firstCommand < 10000) {
        console.log(`[RATE LIMITER] User ${userId} rate limited: ${userData.count} commands in ${Math.floor((now - userData.firstCommand) / 1000)}s`);
        return false;
      }

      if (userData.count >= 3 && now - userData.firstCommand < 1000) {
        console.log(`[RATE LIMITER] User ${userId} rate limited: ${userData.count} commands in <1s`);
        return false;
      }

      if (userData.count === 1) {
        userData.firstCommand = now;
      }
      userData.count++;
      userData.lastCommand = now;
      this.userRateLimits.set(userId, userData);
    } else {
      this.userRateLimits.set(userId, {
        count: 1,
        firstCommand: now,
        lastCommand: now
      });
    }

    return true;
  }

  cleanupOldEntries(now) {
    for (const [userId, userData] of this.userRateLimits.entries()) {
      if (now - userData.lastCommand > 60000) {
        this.userRateLimits.delete(userId);
      }
    }
  }
}

module.exports = RateLimiter;