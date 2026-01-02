<p align="center">
  <img src="src/taskpane/assets/logo.png" alt="Goosefarm" width="80" height="80">
</p>

<h1 align="center">Goosefarm</h1>

<p align="center">
  <strong>AI-powered contract review for Microsoft Word</strong>
</p>

<p align="center">
  Automatically analyze contracts clause-by-clause, apply tracked changes, and add comments—all without leaving Word.
</p>

---

## ✨ Features

- **Live Document Markup** — Watch as the AI analyzes your contract in real-time, applying edits directly with Track Changes
- **Clause-by-Clause Analysis** — Breaks contracts into sections and reviews each one, streaming results as issues are found
- **Smart Risk Detection** — Flags liability caps, indemnification clauses, IP assignments, auto-renewals, and more
- **Native Word Integration** — Uses Word's Track Changes and Comments, so you can accept/reject edits naturally
- **Interactive Chat Mode** — Ask questions about specific clauses or get explanations in plain language
- **Configurable Risk Posture** — Choose Balanced, Risk-Averse, or Aggressive review styles

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Microsoft Word for Mac (with add-in support)
- OpenAI API key (or Azure OpenAI)

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your API key:

```env
OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-4o
```

### 3. Generate HTTPS Certificates

Office add-ins require HTTPS. Generate a self-signed certificate:

```bash
cd certs
./generate.sh   # Or follow manual steps in certs/README.md
```

### 4. Start the Servers

```bash
# Terminal 1: Frontend (serves the add-in UI)
http-server src -S -C certs/dev.crt -K certs/dev.key -p 3000 --cors -c-1

# Terminal 2: Backend (AI proxy)
npm run start:server
```

### 5. Install the Add-in in Word

```bash
# Copy manifest to Word's add-in folder
mkdir -p ~/Library/Containers/com.microsoft.Word/Data/Documents/wef
cp manifest.xml ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/
```

Then restart Word and go to **Insert → Add-ins → My Add-ins → Developer Add-ins**.

## 📖 Usage

1. **Open a contract** in Microsoft Word
2. **Launch Goosefarm** from the ribbon
3. **Choose a mode:**
   - **Chat** — Ask questions about selected text
   - **Redlining** — Analyze and mark up the document
4. **Select scope** (Selection, Paragraph, or full Document)
5. **Click "Analyze Contract"** and watch the AI work

Issues appear in the sidebar as they're found. Click any issue to jump to that location in the document.

## 🏗️ Architecture

```
┌─────────────────┐     HTTPS      ┌─────────────────┐
│   Microsoft     │◄──────────────►│   Frontend      │
│   Word          │                │   (port 3000)   │
│                 │                │   taskpane UI   │
└─────────────────┘                └────────┬────────┘
                                            │
                                            │ HTTPS
                                            ▼
                                   ┌─────────────────┐     ┌─────────────┐
                                   │   Backend       │────►│   OpenAI    │
                                   │   (port 8787)   │     │   API       │
                                   │   AI proxy      │     └─────────────┘
                                   └─────────────────┘
```

## 📁 Project Structure

```
├── manifest.xml              # Office add-in manifest
├── src/
│   └── taskpane/
│       ├── taskpane.html     # Main UI
│       ├── taskpane.css      # Styles
│       ├── taskpane.js       # Frontend logic
│       ├── assets/           # Icons and branding
│       ├── services/         # Word API & AI services
│       └── utils/            # Diff algorithms, storage
├── server/
│   └── index.js              # Express backend with SSE streaming
└── certs/                    # HTTPS certificates (gitignored)
```

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | Your OpenAI API key | Required |
| `OPENAI_MODEL` | Model to use | `gpt-4o` |
| `AI_PROVIDER` | `openai` or `azure` | `openai` |
| `PORT` | Backend server port | `8787` |

### Azure OpenAI

```env
AI_PROVIDER=azure
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_KEY=your-key
AZURE_OPENAI_DEPLOYMENT=your-deployment
AZURE_OPENAI_API_VERSION=2024-06-01
```

## 🔧 Troubleshooting

<details>
<summary><strong>Add-in won't load / network error</strong></summary>

Ensure both servers are running:
```bash
curl -k https://localhost:3000/taskpane/taskpane.html  # Should return HTML
curl -k https://localhost:8787/api/review             # Should return error (no body)
```
</details>

<details>
<summary><strong>Certificate warning in Word</strong></summary>

Click "Continue" on the certificate prompt. For a permanent fix, trust the certificate in Keychain Access:
1. Open Keychain Access
2. File → Import Items → select `certs/dev.crt`
3. Find "localhost", double-click, expand Trust
4. Set "When using this certificate" to "Always Trust"
</details>

<details>
<summary><strong>Changes not appearing after code updates</strong></summary>

Word caches aggressively. Clear the cache:
```bash
rm -rf ~/Library/Containers/com.microsoft.Word/Data/Library/Caches/WebKit/*
```
Then restart Word.
</details>

<details>
<summary><strong>Icon showing as generic square</strong></summary>

Clear all Office caches:
```bash
rm -rf ~/Library/Containers/com.microsoft.Word/Data/Library/Application\ Support/Microsoft/Office/16.0/Wef/*
cp manifest.xml ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/
```
Restart Word completely.
</details>

## 🔒 Security

- API keys are stored server-side only, never exposed to the browser
- All communication uses HTTPS
- The backend acts as a secure proxy to the AI provider
- For production, implement proper authentication

## 📄 License

MIT

---

<p align="center">
  Built with ❤️ for contract professionals
</p>
