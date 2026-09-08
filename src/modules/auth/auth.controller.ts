import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../common/auth/public.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { OtpRequestDto, OtpVerifyDto } from './dto/otp.dto';
import type { AuthenticatedUser } from './auth.types';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(
      dto.email,
      dto.password,
      req.get('user-agent') ?? null,
      req.ip ?? 'unknown',
    );
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, req.get('user-agent') ?? null);
  }

  // Public: logging out must work even once the access token has expired.
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }

  // Authenticated: revoking every session is a privileged act on your own
  // account, so it needs a valid access token rather than one refresh token.
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@CurrentUser() user: AuthenticatedUser) {
    await this.auth.logoutAll(user.userId);
  }

  @Public()
  @Post('otp/request')
  @HttpCode(204)
  async requestOtp(@Body() dto: OtpRequestDto, @Req() req: Request) {
    await this.auth.requestOtp(dto.phone, dto.locale, req.ip ?? 'unknown');
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() dto: OtpVerifyDto, @Req() req: Request) {
    return this.auth.verifyOtp(dto.phone, dto.code, req.get('user-agent') ?? null);
  }
}

