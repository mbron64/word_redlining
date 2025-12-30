# Development Certificates

This folder holds local HTTPS certificates for hosting the task pane at `https://localhost:3000`.

## Quick Setup

For basic development, a simple certificate works fine:

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout dev.key -out dev.crt -days 365 -subj "/CN=localhost"
```

Word will show a "Verify Certificate" prompt — just click **Continue**.

## If you regenerate the certificate

**Important:** If you regenerate the certificate (run the openssl command again), clicking "Continue" will stop working. Word only remembers the trust for the specific certificate it saw before.

To fix this, you need to properly trust the new certificate in Keychain Access (see below).

## Trusting a new certificate (with SAN)

Generate a certificate with proper SAN extensions:

```bash
# Create config file
cat > localhost.cnf << 'EOF'
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
C = US
ST = NY
L = New York
O = Goosefarm Dev
CN = localhost

[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = 127.0.0.1
IP.1 = 127.0.0.1
EOF

# Generate certificate and key
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout dev.key \
  -out dev.crt \
  -days 365 \
  -config localhost.cnf
```

## Trust the certificate (macOS)

**Option 1: Keychain Access (recommended)**

1. Open **Keychain Access** (Spotlight → "Keychain Access")
2. Go to **File → Import Items**
3. Select `dev.crt` from this folder
4. Find **"localhost"** in the list and double-click it
5. Expand **"Trust"**
6. Set **"When using this certificate"** to **"Always Trust"**
7. Close and enter your password

**Option 2: Command line**

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain dev.crt
```

## Files

- `dev.crt` - Certificate file (generated, gitignored)
- `dev.key` - Private key file (generated, gitignored)
- `localhost.cnf` - OpenSSL config for SAN (generated)
- `dev.crt.example` - Placeholder showing expected file
- `dev.key.example` - Placeholder showing expected file

## Verify certificate

```bash
openssl x509 -in dev.crt -text -noout | grep -A1 "Subject Alternative Name"
```

Should show:
```
X509v3 Subject Alternative Name: 
    DNS:localhost, DNS:127.0.0.1, IP Address:127.0.0.1
```
