import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Deliberately loose on shape: an Expo token is `ExponentPushToken[...]`, but a
// bare-workflow development build registers a raw FCM or APNs token instead,
// and rejecting those would be a puzzling failure to debug from the client.
const pushToken = z.string().min(1).max(200);

export const registerDeviceSchema = z.object({
  token: pushToken,
  platform: z.enum(['ios', 'android']),
});

export const revokeDeviceSchema = z.object({
  token: pushToken,
});

export class RegisterDeviceDto extends createZodDto(registerDeviceSchema) {}
export class RevokeDeviceDto extends createZodDto(revokeDeviceSchema) {}
