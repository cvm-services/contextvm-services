# Vendored crypto

`noble.js` is a 25 KB browser bundle of the only three primitives the signer needs:

- `schnorr` (BIP-340) from `@noble/curves/secp256k1`
- `sha256` from `@noble/hashes/sha2`
- `bytesToHex` / `hexToBytes` from `@noble/hashes/utils`

It is **committed on purpose**. The PWA must ship its own crypto and must not fetch
a signing library from a third-party origin — under a strict CSP that would either
break the page or force `script-src` to include someone else's CDN, in an app that
holds a key which authorises payments.

## Regenerate

```bash
cd /tmp/vendtest && rm -rf node_modules
bun add @noble/curves@2.0.1 @noble/hashes@2.0.1
cat > entry.js <<'JS'
export { schnorr } from "@noble/curves/secp256k1.js";
export { sha256 } from "@noble/hashes/sha2.js";
export { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
JS
bun build entry.js --target=browser --format=esm --minify --outfile=noble.js
cp noble.js <repo>/services/restaurant-cvm/web/vendor/noble.js
```

Pin the versions you actually install — a crypto dependency that drifts silently is
worse than one that fails to build.
