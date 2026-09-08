/**
 * Shared SWC transform options for both Vitest projects.
 *
 * legacyDecorator + decoratorMetadata are load-bearing: without them SWC drops
 * the `design:paramtypes` metadata that NestJS dependency injection reads, and
 * every constructor-injected provider resolves as undefined at runtime.
 */
export const swcOptions = {
  module: { type: 'es6' } as const,
  jsc: {
    target: 'es2022' as const,
    parser: { syntax: 'typescript' as const, decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
};
