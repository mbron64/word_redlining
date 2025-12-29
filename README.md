# Redline AI Word Add-in

AI-assisted contract review for Microsoft Word. The task pane reads the selected clause, sends it to a secure backend, and applies tracked changes plus comments.

## What’s included
- `manifest.xml` for sideloading the add-in
- Task pane UI in `src/taskpane/`
- Backend proxy in `server/` that calls OpenAI or Azure OpenAI

## Backend setup

```bash
npm install
npm run start:server
```

Environment variables:

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

The server listens on `http://localhost:8787` by default. The task pane expects a full URL (for example, `http://localhost:8787/api/review`).

## Task pane hosting

Office add-ins require HTTPS for the task pane UI. You can host `src/` with any HTTPS static server and point the manifest to it. For local development, generate a local certificate and serve `src/` at `https://localhost:3000`.

## Add-in sideloading

1. Update the manifest URLs if your host differs from `https://localhost:3000`.
2. Sideload `manifest.xml` in Word (Insert > Add-ins > Upload My Add-in).
3. Open the “Redline AI” tab and launch the task pane.

## Security notes
- Do not embed API keys in the task pane code.
- Use the backend proxy or enterprise auth for production use.
