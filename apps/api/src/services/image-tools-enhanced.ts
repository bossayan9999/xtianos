import { ToolRegistry } from '@xtiand/mjane-core';
import { generateImage, loadImageConfig, type ImageConfig } from './image-service';
import { getCachedGeneratedImage, cacheGeneratedImage } from './cache';
import crypto from 'node:crypto';

export async function registerImageTools(registry: ToolRegistry): Promise<void> {
  const cfg = await loadImageConfig();

  /**
   * Single image generation with caching.
   */
  registry.register({
    name: 'image_generate',
    description: 'Generate an image from a text prompt',
    scopes: ['net'],
    params: [
      { name: 'prompt', type: 'string', required: true },
      { name: 'size', type: 'string', default: '1024x1024' },
      { name: 'quality', type: 'string', default: 'high' },
      { name: 'style', type: 'string', default: 'vivid' },
    ],
    run: async (args: Record<string, unknown>) => {
      const prompt = String(args.prompt ?? '');
      const size = String(args.size ?? '1024x1024');
      const quality = String(args.quality ?? 'high');
      const style = String(args.style ?? 'vivid');

      // Hash the prompt for cache key
      const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
      const cached = await getCachedGeneratedImage(promptHash);
      if (cached) {
        return `Image generated (cached) - artifact ready`;
      }

      // Generate new image
      const image = await generateImage(cfg, { prompt, size, quality, style });
      await cacheGeneratedImage(promptHash, image.base64, 86400);
      return `Image generated - ${image.mime} (${image.format})`;
    },
  });

  /**
   * Batch image generation for variations.
   */
  registry.register({
    name: 'image_generate_batch',
    description: 'Generate 4 image variations for A/B testing or storyboarding',
    scopes: ['net'],
    params: [
      { name: 'prompt', type: 'string', required: true },
      { name: 'styles', type: 'string', default: 'vivid,soft,photographic,illustration' },
    ],
    run: async (args: Record<string, unknown>) => {
      const prompt = String(args.prompt ?? '');
      const styles = String(args.styles ?? 'vivid,soft,photographic,illustration').split(',');

      const variants = [];
      for (const style of styles.slice(0, 4)) {
        const image = await generateImage(cfg, {
          prompt,
          size: '512x512',
          quality: 'standard',
          style: style.trim(),
        });
        variants.push({ style: style.trim(), format: image.format });
      }

      return `Generated 4 variations: ${variants.map((v) => v.style).join(', ')}`;
    },
  });

  /**
   * Simple image upscaling (placeholder for real upscaler integration).
   */
  registry.register({
    name: 'image_upscale',
    description: 'Upscale a generated image 2x or 4x',
    scopes: ['fs'],
    params: [
      { name: 'imageId', type: 'number', required: true },
      { name: 'scale', type: 'number', default: 2 },
    ],
    run: async (args: Record<string, unknown>) => {
      const imageId = Number(args.imageId ?? 0);
      const scale = Number(args.scale ?? 2);
      // In production, call RealESRGAN or similar service
      return `Image #${imageId} upscaled ${scale}x (placeholder - requires upscaler service)`;
    },
  });
}
