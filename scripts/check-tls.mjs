// No API keys or paid model calls: exercise the same default Node fetch TLS path.
import { assertSafeTrust } from './tls-trust.mjs';
assertSafeTrust();
const rejected = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'SELF_SIGNED_CERT_IN_CHAIN']);
for (const [url, allowed] of [
  ['https://www.google.com/', true],
  ['https://dv-g3b-emudhra.we-have-a-problem.com/', false],
  ['https://dv-g3b-aaa-emudhra.we-have-a-problem.com/', false],
]) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    await response.body?.cancel();
    if (!allowed) throw new Error(`Unexpectedly trusted ${url}`);
    console.log(JSON.stringify({ url, status: response.status, passed: true }));
  } catch (error) {
    const code = error.cause?.code ?? error.code;
    if (allowed || !rejected.has(code)) throw error;
    console.log(JSON.stringify({ url, certificateError: code, passed: true }));
  }
}
