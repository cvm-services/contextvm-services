/**
 * Where the customer API listens.
 *
 * Default is loopback: a misconfigured or unconfigured start must not become a
 * public listener. The FIPS address is an explicit operator choice
 * (`CVM_CUSTOMER_HOST`), so exposing the service over the mesh is never
 * accidental.
 */
export function readListenHost(env: (name: string) => string | undefined): string {
  const host = env("CVM_CUSTOMER_HOST")?.trim();
  return host || "127.0.0.1";
}
