import { Module } from '@nestjs/common';
import { AuthPublicController } from './auth-public.controller';
import { AuthController } from './auth.controller';
import { PasskeyController } from './passkey.controller';
import { AuthService } from './auth.service';
import { RateLimitService } from './rate-limit.service';

/**
 * Auth module — public flows (login/register/reset/mfa-verify/logout) and the
 * authenticated account/MFA/token endpoints. OIDC remains a separate Nest module
 * under /api/auth/oidc so each surface keeps its own controller and guards.
 */
@Module({
  controllers: [AuthPublicController, AuthController, PasskeyController],
  providers: [AuthService, RateLimitService],
})
export class AuthModule {}
