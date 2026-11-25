import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@/config/env.js';
import { AuthenticationError } from '@/common/errors/app-error.js';
import { hashPassword, verifyPassword } from '@/common/security/password.js';
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
    this.dummyHash = hashPassword(randomUUID());
  }

  public async login(input: LoginInput, context: SessionContext): Promise<TokenPair> {
    const user = await this.repository.findUserByEmail(input.email);
    const hash = user?.passwordHash ?? (await this.dummyHash);
    const validPassword = await verifyPassword(hash, input.password);
    if (!user || !user.isActive || !validPassword)
      throw new AuthenticationError('Invalid email or password');

    const publicUser: PublicUser = { id: user.id, email: user.email, role: user.role };
    return this.issueNewSession(publicUser, context, user.passwordHash);
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

  private async issueNewSession(
    user: PublicUser,
    context: SessionContext,
    verifiedPasswordHash: string,
  ): Promise<TokenPair> {
    const refreshToken = this.tokens.createRefreshToken();
    const created = await this.repository.createSession(
      {
        tokenHash: this.tokens.hashRefreshToken(refreshToken),
        userId: user.id,
        familyId: randomUUID(),
        expiresAt: this.refreshExpiry(),
        ...context,
      },
      verifiedPasswordHash,
    );
    if (!created) throw new AuthenticationError('Invalid email or password');
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
