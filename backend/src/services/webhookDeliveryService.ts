import logger from '../utils/logger.js';
import { getOutboundTraceparent } from '../utils/requestContext.js';
import { signWebhookPayload, getActiveSecret } from './webhookSigningService.js';

export interface WebhookDelivery {
  endpoint: string;
  payload: Record<string, unknown>;
  subscriberId: string;
}

export async function sendWebhook(delivery: WebhookDelivery): Promise<void> {
  const { endpoint, payload, subscriberId } = delivery;

  try {
    const secret = await getActiveSecret(subscriberId);

    if (!secret) {
      logger.warn('No active webhook secret found, delivery skipped', {
        subscriberId,
        endpoint,
      });
      return;
    }

    const { signature, timestamp } = signWebhookPayload(payload, secret);
    const payloadStr = JSON.stringify(payload);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-remitlend-signature': signature,
        'x-remitlend-timestamp': timestamp,
        // Continue the caller's trace (indexer pass or API request) into the
        // subscriber's logs (#414). Uses a child span so the delivery hop is
        // distinguishable from the work that triggered it.
        traceparent: getOutboundTraceparent(),
      },
      body: payloadStr,
      timeout: 10000, // 10 second timeout
    });

    if (!response.ok) {
      logger.warn('Webhook delivery failed', {
        subscriberId,
        endpoint,
        statusCode: response.status,
        statusText: response.statusText,
      });
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    logger.info('Webhook delivered successfully', {
      subscriberId,
      endpoint,
      statusCode: response.status,
    });
  } catch (error) {
    logger.error('Failed to send webhook', {
      subscriberId,
      endpoint,
      error,
    });
    throw error;
  }
}

export async function sendWebhookAsync(delivery: WebhookDelivery): Promise<void> {
  setImmediate(() => {
    sendWebhook(delivery).catch((error) => {
      logger.error('Async webhook delivery failed', {
        subscriberId: delivery.subscriberId,
        endpoint: delivery.endpoint,
        error,
      });
    });
  });
}
