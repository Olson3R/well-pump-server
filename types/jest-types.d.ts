/**
 * `jest.Mocked<T>` does not unwrap Prisma's overloaded generic methods (e.g.
 * `prisma.event.findMany`) — TypeScript keeps resolving them as the original
 * overloaded signature, which does not expose `.mockResolvedValue` etc. The
 * pragmatic fix is to flatten every function property to a plain `jest.Mock`
 * so the standard jest mock helpers are available on it.
 *
 * Tests cast the imported (and `jest.mock(...)`-replaced) module with this
 * helper, e.g.
 *
 *   const mockPrisma = prisma as unknown as DeepMocked<typeof prisma>
 */
declare type DeepMocked<T> = {
  [P in keyof T]: T[P] extends (...args: never[]) => unknown
    ? jest.Mock
    : T[P] extends object
    ? DeepMocked<T[P]>
    : T[P]
}
