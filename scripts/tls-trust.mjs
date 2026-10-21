// Validate the exact OpenSSL file selected at process startup. Node's CA-list
// enumeration does not include OpenSSL file/directory roots in this mode.
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { getCACertificates } from 'node:tls';

const blocked = new Set(["d7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4", "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b"]);
export function assertSafeTrust() {
  const options = `${process.env.NODE_OPTIONS ?? ''} ${process.execArgv.join(' ')}`;
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled');
  if (!options.includes('--use-openssl-ca')) {
    const certificates = getCACertificates('default');
    if (!certificates.length) throw new Error('Default TLS trust store is empty');
    checkCertificates(certificates, 'managed Node default roots');
    return;
  }
  if (/--use-(bundled|system)-ca/.test(options)) throw new Error('Do not mix OpenSSL, bundled and system CA modes');
  if (!process.env.SSL_CERT_FILE || !process.env.SSL_CERT_DIR || existsSync(process.env.SSL_CERT_DIR)) {
    throw new Error('Select SSL_CERT_FILE and a nonexistent SSL_CERT_DIR to exclude other OpenSSL roots');
  }
  for (const file of [process.env.SSL_CERT_FILE, process.env.NODE_EXTRA_CA_CERTS].filter(Boolean)) {
    const certificates = readFileSync(file, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    if (!certificates.length) throw new Error(`Empty TLS trust file: ${file}`);
    checkCertificates(certificates, file);
  }
}

function checkCertificates(certificates, file) {
    for (const pem of certificates) {
      const cert = new X509Certificate(pem);
      if (blocked.has(cert.fingerprint256.replaceAll(':', '').toLowerCase())) {
        throw new Error(`Affected eMudhra trust path remains in ${file}: ${cert.subject}. Update the CA bundle.`);
      }
    }
}
