import type { CookieOptions, Request, Response } from 'express';
import type { AppConfig } from '@/config/env.js';
import { AuthenticationError } from '@/common/errors/app-error.js';
import { success } from '@/common/types/http.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import type { LoginInput } from '@/modules/auth/auth.validation.js';

export class AuthController {
  public constructor(
    private readonly service: AuthService,
    private readonly config: AppConfig,
  ) {}

  public login = async (request: Request, response: Response): Promise<void> => {
    const result = await this.service.login(request.body as LoginInput, this.context(request));
    this.setRefreshCookie(response, result.refreshToken);
    response.json(success(this.accessPayload(result), 'Login successful'));
  };

  public refresh = async (request: Request, response: Response): Promise<void> => {
    const token = request.cookies[this.config.REFRESH_COOKIE_NAME] as unknown;
    if (typeof token !== 'string') throw new AuthenticationError('Invalid refresh session');
    const result = await this.service.refresh(token, this.context(request));
    this.setRefreshCookie(response, result.refreshToken);
    response.json(success(this.accessPayload(result), 'Token refreshed'));
  };

  public logout = async (request: Request, response: Response): Promise<void> => {
    const token = request.cookies[this.config.REFRESH_COOKIE_NAME] as unknown;
    await this.service.logout(typeof token === 'string' ? token : undefined);
    response.clearCookie(this.config.REFRESH_COOKIE_NAME, this.cookieOptions());
    response.json(success({}, 'Logout successful'));
  };

  public me = (request: Request, response: Response): void => {
    if (!request.user) throw new AuthenticationError();
    response.json(success({ user: request.user }));
  };

  private context(request: Request): { ipAddress: string; userAgent?: string } {
    const userAgent = request.header('user-agent')?.slice(0, 512);
    return {
      ipAddress: request.ip ?? request.socket.remoteAddress ?? '127.0.0.1',
      ...(userAgent ? { userAgent } : {}),
    };
  }

  private accessPayload(result: Awaited<ReturnType<AuthService['login']>>): object {
    return {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  private setRefreshCookie(response: Response, token: string): void {
    response.cookie(this.config.REFRESH_COOKIE_NAME, token, {
      ...this.cookieOptions(),
      maxAge: this.config.REFRESH_TOKEN_TTL_SECONDS * 1000,
    });
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: this.config.COOKIE_SAME_SITE,
      path: '/api/v1/auth',
      ...(this.config.COOKIE_DOMAIN ? { domain: this.config.COOKIE_DOMAIN } : {}),
    };
  }
}
