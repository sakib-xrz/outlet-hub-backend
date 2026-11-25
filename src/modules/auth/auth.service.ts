import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { AppConfig } from '@/config/env.js';
import { AuthenticationError } from '@/common/errors/app-error.js';
import type { AuthRepository } from '@/modules/auth/auth.repository.js';
import type { LoginInput } from '@/modules/auth/auth.validation.js';
import type { PublicUser, SessionContext, TokenPair } from '@/modules/auth/auth.types.js';
import type { TokenService } from '@/modules/auth/token.service.js';

export class AuthService {
  private readonly dummyHash: Promise<string>;

  public constructor(
    private readonly repository: AuthRepository,
    private readonly tokens: TokenService,
    private readonly config: AppConfig,
  ) {
    this.dummyHash = argon2.hash(randomUUID(), { type: argon2.argon2id });
  }

  public async login(input: LoginInput, context: SessionContext): Promise<TokenPair> {
    const user = await this.repository.findUserByEmail(input.email);
    const hash = user?.passwordHash ?? (await this.dummyHash);
    const validPassword = await argon2.verify(hash, input.password).catch(() => false);
    if (!user || !user.isActive || !validPassword)
      throw new AuthenticationError('Invalid email or password');

    const publicUser: PublicUser = { id: user.id, email: user.email, role: user.role };
    return this.issueNewSession(publicUser, context);
  }

  public async refresh(refreshToken: string, context: SessionContext): Promise<TokenPair> {
    const replacement = this.tokens.createRefreshToken();
    const result = await this.repository.rotateSession(this.tokens.hashRefreshToken(refreshToken), {
      tokenHash: this.tokens.hashRefreshToken(replacement),
      expiresAt: this.refreshExpiry(),
      ...context,
    });
    if (result.kind !== 'rotated') throw new AuthenticationError('Invalid refresh session');
    return {
      accessToken: await this.tokens.signAccessToken(result.user),
      refreshToken: replacement,
      expiresIn: this.config.JWT_ACCESS_TTL_SECONDS,
      user: result.user,
    };
  }

  public async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken)
      await this.repository.revokeSession(this.tokens.hashRefreshToken(refreshToken));
  }

  public async getCurrentUser(id: string): Promise<PublicUser> {
    const user = await this.repository.findActiveUserById(id);
    if (!user) throw new AuthenticationError();
    return user;
  }

  private async issueNewSession(user: PublicUser, context: SessionContext): Promise<TokenPair> {
    const refreshToken = this.tokens.createRefreshToken();
    await this.repository.createSession({
      tokenHash: this.tokens.hashRefreshToken(refreshToken),
      userId: user.id,
      familyId: randomUUID(),
      expiresAt: this.refreshExpiry(),
      ...context,
    });
    return {
      accessToken: await this.tokens.signAccessToken(user),
      refreshToken,
      expiresIn: this.config.JWT_ACCESS_TTL_SECONDS,
      user,
    };
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000);
  }
}
