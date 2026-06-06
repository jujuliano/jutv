import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Endpoint to fetch and list images from a public/private Google Drive folder
  app.get("/api/drive-images", async (req, res) => {
    try {
      const folderParam = (req.query.folder || "").toString().trim();
      const accessToken = (req.headers["authorization"] || req.query.accessToken || "").toString().trim();
      
      // Extract Folder ID from Google Drive URL or assume raw ID
      let folderId = folderParam;
      const folderUriMatch = folderParam.match(/folders\/([a-zA-Z0-9_-]{28,45})/);
      if (folderUriMatch) {
         folderId = folderUriMatch[1];
      }

      if (!folderId) {
        return res.status(400).json({ error: "Parâmetro do ID da pasta do Google Drive é obrigatório." });
      }

      const files: { id: string; name: string; mimeType: string; url: string }[] = [];

      // 1. If an access token is available, attempt to call the official Google Drive API
      if (accessToken) {
        try {
          const authHeader = accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`;
          const driveApiUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType)&pageSize=100`;
          
          const response = await fetch(driveApiUrl, {
            headers: {
              "Authorization": authHeader
            }
          });

          if (response.ok) {
            const data = await response.json();
            if (data && Array.isArray(data.files)) {
              for (const file of data.files) {
                if (file.mimeType && (file.mimeType.startsWith("image/") || file.mimeType === "application/octet-stream")) {
                  // Octet stream can sometimes be images uploaded with raw types, but we'll prioritize images
                  files.push({
                    id: file.id,
                    name: file.name,
                    mimeType: file.mimeType,
                    url: `/api/drive-image-proxy?id=${file.id}&accessToken=${encodeURIComponent(accessToken)}`
                  });
                }
              }
            }
          } else {
            console.warn(`Official Drive API listing failed with status: ${response.status}. Falling back to public scraping.`);
          }
        } catch (authErr) {
          console.error("Failed to fetch folder files using Google Drive API", authErr);
        }
      }

      // 2. Fallback: Parse public Google Drive folder page directly
      if (files.length === 0) {
        const driveUrl = `https://drive.google.com/drive/folders/${folderId}`;
        const response = await fetch(driveUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36"
          }
        });

        if (!response.ok) {
          throw new Error(`Google Drive returned status: ${response.status}`);
        }

        const text = await response.text();

        // Pattern 1: Look for decoded initially loaded elements inside window['_DRIVE_ivd']
        const driveIvdPattern = /window\['_DRIVE_ivd'\]\s*=\s*'([^']+)'/i;
        const ivdMatch = text.match(driveIvdPattern);
        
        if (ivdMatch) {
          try {
            const rawHexStr = ivdMatch[1];
            const decoded = rawHexStr.replace(/\\x([0-9a-fA-F]{2})/g, (_, hexNum) => {
              return String.fromCharCode(parseInt(hexNum, 16));
            });
            
            const rawJson = JSON.parse(decoded);
            
            // Traverse JSON to scan for files
            function traverse(item: any) {
              if (!item) return;
              if (Array.isArray(item)) {
                if (
                  item.length >= 4 &&
                  typeof item[0] === "string" &&
                  item[0].length >= 28 &&
                  item[0].length <= 45 &&
                  typeof item[2] === "string" &&
                  typeof item[3] === "string" &&
                  item[3].includes("/")
                ) {
                  // It's a file metadata array! Let's save it
                  const fileId = item[0];
                  const mime = item[3];
                  // Check if it's an image file
                  if (mime.startsWith("image/")) {
                    files.push({
                      id: fileId,
                      name: item[2],
                      mimeType: mime,
                      url: `/api/drive-image-proxy?id=${fileId}`
                    });
                  }
                }
                for (const child of item) {
                  traverse(child);
                }
              }
            }
            traverse(rawJson);
          } catch (jsonErr) {
            console.error("Failed to parse decodable window['_DRIVE_ivd'] payload", jsonErr);
          }
        }

        // Pattern 2 Backup: Look for matching arrays directly in text to support secondary structures
        if (files.length === 0) {
          const backupRegex = /\["([a-zA-Z0-9_-]{28,45})",\["[a-zA-Z0-9_-]{28,45}"\],"([^"]+)","(image\/[^"]+)"/g;
          let bMatch;
          while ((bMatch = backupRegex.exec(text)) !== null) {
            const fileId = bMatch[1];
            if (!files.some(f => f.id === fileId)) {
              files.push({
                id: fileId,
                name: bMatch[2],
                mimeType: bMatch[3],
                url: `/api/drive-image-proxy?id=${fileId}`
              });
            }
          }
        }
      }

      // Return lists
      res.json({ folderId, count: files.length, files });
    } catch (error: any) {
      console.error("Error fetching Google Drive folder details", error);
      res.status(500).json({ error: "Erro ao obter imagens do Google Drive.", details: error.message });
    }
  });

  // Real-time image proxy to bypass Google Drive CORS & virus scan limits
  app.get("/api/drive-image-proxy", async (req, res) => {
    try {
      const fileId = (req.query.id || "").toString().trim();
      const accessToken = (req.query.accessToken || req.headers["authorization"] || "").toString().trim();
      if (!fileId) {
        return res.status(400).send("ID do arquivo do Google Drive é obrigatório.");
      }

      // 1. If we have an credentials, query the official media download endpoint
      if (accessToken) {
        try {
          const authHeader = accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`;
          const driveApiUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
          
          const response = await fetch(driveApiUrl, {
            headers: {
              "Authorization": authHeader
            }
          });

          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const contentType = response.headers.get("content-type") || "image/jpeg";
            res.setHeader("Content-Type", contentType);
            res.setHeader("Cache-Control", "public, max-age=86400"); // Cache 24h
            return res.send(buffer);
          } else {
            console.warn(`Auth image proxy failed with status: ${response.status}. Falling back to public.`);
          }
        } catch (proxyErr) {
          console.error("Failed to download image through official Google Drive API", proxyErr);
        }
      }

      // 2. Public Fallback: download thumbnail
      const driveUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;
      const response = await fetch(driveUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"
        }
      });

      if (!response.ok) {
        // Fallback to direct stream backup
        const backupUrl = `https://docs.google.com/uc?export=download&id=${fileId}`;
        const backupResponse = await fetch(backupUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"
          }
        });

        if (!backupResponse.ok) {
          throw new Error(`Google Drive returned status: ${backupResponse.status}`);
        }

        const arrayBuffer = await backupResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentType = backupResponse.headers.get("content-type") || "image/jpeg";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=86400"); // Cache 24h
        return res.send(buffer);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const contentType = response.headers.get("content-type") || "image/jpeg";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400"); // Cache 24h
      res.send(buffer);
    } catch (err: any) {
      console.error("Error streaming image from driver proxy", err);
      // Failsafe HTTP redirect in case of fetch errors
      const fileId = req.query.id;
      if (fileId) {
        return res.redirect(`https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`);
      }
      res.status(500).send("Erro ao obter a imagem.");
    }
  });

  // Real-time text proxy to bypass Google Drive CORS & fetch .txt content directly
  app.get("/api/drive-text", async (req, res) => {
    try {
      const fileUrl = (req.query.url || "").toString().trim();
      const accessToken = (req.headers["authorization"] || req.query.accessToken || "").toString().trim();
      if (!fileUrl) {
        return res.status(400).json({ error: "URL do arquivo do Google Drive é obrigatória." });
      }

      // Robust pattern matching to extract the 28-45 character Google Drive file ID
      let fileId = fileUrl;
      const fileIdMatch = fileUrl.match(/\/file\/d\/([a-zA-Z0-9_-]{28,45})/i) || 
                          fileUrl.match(/\/d\/([a-zA-Z0-9_-]{28,45})/i) || 
                          fileUrl.match(/[?&]id=([a-zA-Z0-9_-]{28,45})/i);
      
      if (fileIdMatch) {
        fileId = fileIdMatch[1];
      }

      if (!fileId || fileId.length < 20) {
        return res.status(400).json({ error: "Não foi possível extrair um ID de arquivo válido do Google Drive a partir da URL fornecida." });
      }

      let txt = "";

      // 1. If access token is supplied, fetch using Google Drive API media endpoint
      if (accessToken) {
        try {
          const authHeader = accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`;
          const driveApiUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
          
          const response = await fetch(driveApiUrl, {
            headers: {
              "Authorization": authHeader
            }
          });

          if (response.ok) {
            txt = await response.text();
          } else {
            console.warn(`Authorized drive file download returned status ${response.status}. Trying public fallback.`);
          }
        } catch (apiErr) {
          console.error("Error calling official Google Drive file content API", apiErr);
        }
      }

      // 2. Fallback to public downloader
      if (!txt) {
        const driveUrl = `https://docs.google.com/uc?export=download&id=${fileId}`;
        const response = await fetch(driveUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"
          }
        });

        if (!response.ok) {
          throw new Error(`Google Drive returned status: ${response.status}`);
        }

        txt = await response.text();
      }
      
      // Clean UTF-8 Byte Order Mark (BOM) if present from Windows Notepad editor uploads
      txt = txt.replace(/^\uFEFF/, '').trim();

      res.setHeader("Cache-Control", "public, max-age=15"); // Cache for 15s to keep responsiveness ultra fast but allow near real-time updates
      return res.json({ id: fileId, text: txt });
    } catch (err: any) {
      console.error("Error reading text file from Google Drive proxy", err);
      return res.status(500).json({ error: "Erro ao ler o arquivo de letreiro digital do Google Drive.", details: err.message });
    }
  });

  // Client-side OAuth 2.0 redirect helper that parses and forwards access tokens back to window.opener
  app.get("/oauth2callback.html", (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Autenticando Conta Google</title>
        <style>
          body {
            background-color: #09090b;
            color: #f4f4f5;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
            text-align: center;
          }
          .card {
            background: #18181b;
            border: 1px solid #27272a;
            border-radius: 12px;
            padding: 30px;
            max-width: 400px;
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -4px rgba(0, 0, 0, 0.3);
          }
          h2 { margin: 0 0 12px 0; color: #fff; font-weight: 600; }
          p { margin: 0; font-size: 14px; color: #a1a1aa; line-height: 1.5; }
          .spinner {
            border: 3px solid #27272a;
            border-top: 3px solid #ef4444;
            border-radius: 50%;
            width: 30px;
            height: 30px;
            animation: spin 1s linear infinite;
            margin: 20px auto 0 auto;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <div class="card" id="status-card">
          <h2>Autenticando...</h2>
          <p>Enviando as credenciais do Google para o painel de ajustes. Esta janela deve fechar automaticamente.</p>
          <div class="spinner" id="status-spinner"></div>
        </div>
        <script>
          try {
            const hash = window.location.hash;
            if (hash) {
              const params = new URLSearchParams(hash.substring(1));
              const accessToken = params.get('access_token');
              if (accessToken) {
                if (window.opener) {
                  window.opener.postMessage({ type: 'GOOGLE_OAUTH_SUCCESS', accessToken: accessToken }, '*');
                  setTimeout(() => window.close(), 800);
                } else {
                  localStorage.setItem('google_access_token', accessToken);
                  document.getElementById('status-card').innerHTML = '<h2>Conectado com Sucesso!</h2><p>As configurações da sua conta Google foram armazenadas. Você já pode fechar esta aba e voltar para a TV.</p>';
                }
              } else {
                document.getElementById('status-card').innerHTML = '<h2>Erro na Autenticação</h2><p>Nenhum token de acesso foi encontrado na resposta do Google. Redirecione novamente.</p>';
              }
            } else {
              document.getElementById('status-card').innerHTML = '<h2>Aviso</h2><p>Esta página é uma rota de retorno de autenticação pelo Google. Nenhuma credencial foi enviada.</p>';
            }
          } catch (e) {
            console.error(e);
            document.getElementById('status-card').innerHTML = '<h2>Falha crítica</h2><p>Erro ao transferir token de acesso para o app principal: ' + e.message + '</p>';
          }
        </script>
      </body>
      </html>
    `);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
