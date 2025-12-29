# Development Certificates

This folder holds local HTTPS certificates for hosting the task pane at
`https://localhost:3000`.

Generate a local dev certificate pair (not committed):

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/dev.key \
  -out certs/dev.crt \
  -days 365 -subj "/CN=localhost"
```

Only placeholder examples are stored in git:
- `certs/dev.crt.example`
- `certs/dev.key.example`
