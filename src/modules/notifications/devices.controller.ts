import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { NotFoundError } from '../../common/errors/domain-error';
import { ErrorCodes } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../auth/auth.types';
import { DevicesRepository } from './devices.repository';
import { RegisterDeviceDto, RevokeDeviceDto } from './dto/device.dto';

@ApiBearerAuth()
@Roles('customer', 'operator', 'admin')
@Controller('me/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesRepository) {}

  // 200 rather than 201: the client re-registers on every foreground because
  // the OS may rotate the token between launches, so this usually updates.
  @Post()
  @HttpCode(200)
  async register(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterDeviceDto) {
    await this.devices.register(user.userId, dto.token, dto.platform);
    return { registered: true };
  }

  // A POST carrying the token in the body rather than DELETE /me/devices/:token:
  // an Expo token is shaped `ExponentPushToken[...]`, and those brackets would
  // have to survive percent-encoding through every client, proxy and log.
  @Post('revoke')
  @HttpCode(200)
  async revoke(@CurrentUser() user: AuthenticatedUser, @Body() dto: RevokeDeviceDto) {
    const revoked = await this.devices.revoke(user.userId, dto.token);
    if (!revoked) {
      throw new NotFoundError(ErrorCodes.DEVICE_NOT_FOUND, 'No such active device for this user.');
    }
    return { revoked: true };
  }
}
