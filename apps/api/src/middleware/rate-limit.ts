import { Router, type Request, type Response, type NextFunction } from 'express';
import redis from 'ioredis';

const redisClient = new redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
});

export interface RateLimitOptions {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Max requests per window
  keyGenerator?: (req: Request) => string; // Custom key generator
}

/** Token-bucket rate limiter using Redis. */
export function rateLimitMiddleware(options: RateLimitOptions) {
  const { windowMs, maxRequests, keyGenerator } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = keyGenerator ? keyGenerator(req) : (req as any).authToken || req.ip || 'unknown';
      const redisKey = `ratelimit:${key}`;
      const current = await redisClient.incr(redisKey);

      if (current === 1) {
        await redisClient.expire(redisKey, Math.ceil(windowMs / 1000));
      }

      res.setHeader('X-RateLimit-Limit', String(maxRequests));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - current)));

      if (current > maxRequests) {
        res.status(429).json({
          error: 'Too Many Requests',
          retryAfter: Math.ceil(windowMs / 1000),
        });
        return;
      }

      next();
    } catch (error) {
      console.error('Rate limit middleware error:', error);
      next(); // Allow request if Redis is down
    }
  };
}

/** Image generation cost limiter (prevent abuse). */
export async function checkImageGenerationBudget(
  userId: string,
  costPerImage: number = 0.02, // dollars
  dailyBudget: number = 10, // dollars per day
): Promise<boolean> {
  const key = `image:budget:${userId}:${new Date().toISOString().slice(0, 10)}`;
  const spent = await redisClient.getex(key);
  const currentSpent = spent ? Number.parseFloat(spent) : 0;

  if (currentSpent + costPerImage > dailyBudget) {
    return false;
  }

  const newSpent = currentSpent + costPerImage;
  await redisClient.setex(key, 86400, String(newSpent));
  return true;
}

export async function closeRateLimitRedis(): Promise<void> {
  await redisClient.quit();
}
