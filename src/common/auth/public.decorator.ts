import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * The only way out of global authentication. Protection is opt-OUT so that a
 * newly added endpoint is protected because someone had to choose to expose it.
 * Opt-in protection fails open the first time someone forgets.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
