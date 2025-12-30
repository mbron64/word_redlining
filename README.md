# Goosefarm Word Add-in

AI-powered contract review for Microsoft Word. The task pane reads the selected clause, sends it to a secure backend, and applies tracked changes plus comments.

## What's included
- `manifest.xml` for sideloading the add-in
- Task pane UI in `src/taskpane/`
- Backend proxy in `server/` that calls OpenAI or Azure OpenAI

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Generate HTTPS certificates

Office add-ins require HTTPS. Generate a self-signed certificate with proper Subject Alternative Name (SAN):

```bash
cd certs

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

# Generate certificate
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout dev.key \
  -out dev.crt \
  -days 365 \
  -config localhost.cnf
```

### 3. Certificate trust (macOS)

When you first open the add-in, Word will show a "Verify Certificate" dialog. **Just click "Continue"** — this is normal for self-signed certificates and the add-in will work fine.

If you want to skip this prompt permanently, see the Troubleshooting section below.

### 4. Start the HTTPS server for the task pane

```bash
# Install http-server globally if needed
npm install -g http-server

# Serve the task pane with HTTPS (caching enabled for icons)
http-server src -S -C certs/dev.crt -K certs/dev.key -p 3000 --cors -c3600
```

### 5. Start the backend API server

In a separate terminal:

```bash
npm run start:server
```

The server will automatically use HTTPS if certificates exist in `certs/`. This is required because the taskpane runs over HTTPS and browsers block mixed content (HTTPS → HTTP requests).

### 6. Sideload the add-in (macOS)

On macOS, manually copy the manifest to Word's add-in folder:

```bash
# Create the wef folder if it doesn't exist
mkdir -p ~/Library/Containers/com.microsoft.Word/Data/Documents/wef

# Copy the manifest
cp manifest.xml ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/
```

Then:
1. **Quit Word completely** (⌘Q)
2. **Reopen Word**
3. Go to **Insert → Add-ins → My Add-ins**
4. Look under **"Developer Add-ins"** — Goosefarm should appear
5. Click it to open the task pane

## Backend Configuration

Set these environment variables before running the server:

```bash
# OpenAI (default)
export AI_PROVIDER=openai
export OPENAI_API_KEY=your_key
export OPENAI_MODEL=gpt-4o

# Or Azure OpenAI
export AI_PROVIDER=azure
export AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
export AZURE_OPENAI_KEY=your_key
export AZURE_OPENAI_DEPLOYMENT=your_deployment
export AZURE_OPENAI_API_VERSION=2024-06-01
```

The server listens on `http://localhost:8787` by default.

Tip: Copy `.env.example` to `.env` for persistent configuration.

## Troubleshooting

### Certificate warning won't go away / "Continue" stops working

If you **regenerate the certificate** (e.g., by running the openssl command again), clicking "Continue" will stop working because Word no longer recognizes it. You'll need to properly trust the new certificate:

1. **Regenerate the certificate** with proper SAN (Subject Alternative Name):
   ```bash
   cd certs
   
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

   openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout dev.key -out dev.crt -days 365 -config localhost.cnf
   ```

2. **Trust it in Keychain Access:**
   - Open **Keychain Access** (Spotlight → "Keychain Access")
   - Go to **File → Import Items**
   - Select `certs/dev.crt`
   - Find **"localhost"** in the list, double-click it
   - Expand **"Trust"**
   - Set **"When using this certificate"** to **"Always Trust"**
   - Close and enter your password

3. **Restart the HTTPS server** and **quit/reopen Word**

### Changes not appearing after updating code

Word caches the taskpane content in WebKit caches. If your HTML/CSS/JS changes aren't showing after restarting Word, clear the cache:

```bash
rm -rf ~/Library/Containers/com.microsoft.Word/Data/Library/Caches/WebKit/*
rm -rf ~/Library/Containers/com.microsoft.Word/Data/Library/WebKit/*
rm -rf ~/Library/Containers/com.microsoft.Word/Data/tmp/WebKit/*
```

Then quit and restart Word.

### Add-in not appearing
- Ensure the HTTPS server is running on port 3000
- Check that `manifest.xml` is in `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/`
- Fully quit Word (⌘Q) and reopen

### Icon showing as generic green/teal square

Word caches add-in icons in multiple locations. If your custom icon isn't showing (stuck on a generic square), clear ALL Office caches:

```bash
# Clear all Office add-in caches
rm -rf ~/Library/Containers/com.microsoft.Word/Data/Library/Caches/WebKit/*
rm -rf ~/Library/Containers/com.microsoft.Word/Data/Library/Caches/Microsoft/*
rm -rf ~/Library/Containers/com.microsoft.Word/Data/Library/Application\ Support/Microsoft/Office/16.0/Wef/*
rm -rf ~/Library/Group\ Containers/UBF8T346G9.Office/User\ Content/wef/*
rm -rf ~/Library/Containers/com.microsoft.Word/Data/tmp/wefgallery/*

# Re-copy manifest to both wef locations
cp manifest.xml ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/
cp manifest.xml ~/Library/Group\ Containers/UBF8T346G9.Office/User\ Content/wef/
```

Then **fully quit Word (⌘Q)** and reopen. The key cache is `Office/16.0/Wef/` which stores add-in manifests and resources.

### Icons not displaying at all
- Make sure the HTTPS server is running on port 3000
- Icons must be accessible at the URLs in `manifest.xml` (test with `curl -sk https://localhost:3000/taskpane/assets/icon-32.png`)

## Project Structure

```
├── manifest.xml          # Office add-in manifest
├── src/
│   └── taskpane/
│       ├── taskpane.html # Task pane UI
│       ├── taskpane.css  # Styles
│       ├── taskpane.js   # Frontend logic
│       ├── assets/       # Icons and logo
│       ├── services/     # AI and Word API services
│       └── utils/        # Utilities
├── server/
│   └── index.js          # Backend API proxy
└── certs/                # HTTPS certificates (gitignored)
```

## Security Notes
- Do not embed API keys in the task pane code
- Use the backend proxy to protect API credentials
- For production, use enterprise authentication
