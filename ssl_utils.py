"""TLS certificate helpers for the backup server."""

from __future__ import annotations

import base64
import hashlib
import os

from config import load_config


def fingerprint_from_pem(pem_bytes: bytes) -> str:
    """Return lowercase SHA-256 hex fingerprint of a PEM-encoded certificate."""
    text = pem_bytes.decode("utf-8", errors="ignore").strip()
    b64 = "".join(line for line in text.splitlines() if not line.startswith("-----"))
    der = base64.b64decode(b64)
    return hashlib.sha256(der).hexdigest()


def fingerprint_from_pem_file(cert_path: str) -> str:
    with open(cert_path, "rb") as f:
        return fingerprint_from_pem(f.read())


def ensure_cert() -> tuple[str, str]:
    """Generate a self-signed cert on first run; return (cert_path, key_path).

    Uses the ``cryptography`` library so we never depend on an external
    ``openssl`` binary being on PATH (which is typically absent on Windows).
    """
    cfg = load_config()
    cert_path = cfg["SSL_CERT"]
    key_path = cfg["SSL_KEY"]

    if os.path.exists(cert_path) and os.path.exists(key_path):
        return cert_path, key_path

    cert_dir = os.path.dirname(os.path.abspath(cert_path))
    if cert_dir:
        os.makedirs(cert_dir, exist_ok=True)

    key_dir = os.path.dirname(os.path.abspath(key_path))
    if key_dir:
        os.makedirs(key_dir, exist_ok=True)

    # ── Generate RSA key + self-signed X.509 cert with `cryptography` ──────
    import datetime
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "phonebackup.local"),
    ])

    now_utc = datetime.datetime.now(datetime.timezone.utc)

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now_utc)
        .not_valid_after(now_utc + datetime.timedelta(days=3650))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("phonebackup.local")]),
            critical=False,
        )
        .sign(private_key, hashes.SHA256())
    )

    # Write private key (unencrypted PEM)
    with open(key_path, "wb") as f:
        f.write(
            private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )

    # Write certificate PEM
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    return cert_path, key_path


def get_cert_fingerprint() -> str:
    cfg = load_config()
    cert_path = cfg["SSL_CERT"]
    if not os.path.exists(cert_path):
        ensure_cert()
    return fingerprint_from_pem_file(cert_path)
