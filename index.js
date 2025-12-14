import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (!INTERNAL_API_TOKEN) throw new Error("Missing INTERNAL_API_TOKEN env var");

const SUPABASE_PROJECT_URL = process.env.SUPABASE_PROJECT_URL || "https://mqnvfjteuwqbomvbmyhd.supabase.co";
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json({ limit: "200kb" }));

// CORS defensivo (não é segurança real)
app.use(
  cors({
    origin: (origin, cb) => {
      // server-to-server normalmente vem sem Origin
      if (!origin) return cb(null, true);

      // Se você setar SUPABASE_PROJECT_URL, restringe.
      if (SUPABASE_PROJECT_URL && origin === SUPABASE_PROJECT_URL) return cb(null, true);

      // Se não setar, pode bloquear browser por padrão:
      return cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "OPTIONS", "GET"],
    allowedHeaders: ["Content-Type", "X-Internal-Token"],
    maxAge: 86400,
  })
);

// Health endpoints (NÃO exigem token, pra Render não matar seu serviço)
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Token gate para as rotas “de verdade”
app.use((req, res, next) => {
  // libera GET / e /health
  if (req.method === "GET") return next();

  const token = req.header("X-Internal-Token");
  if (token !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

async function fetchInpiHtmlByMarca(marca) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();

    // 1) home
    await page.goto("https://busca.inpi.gov.br/pePI/", { waitUntil: "domcontentloaded" });

    // 2) login anon
    await page.goto("https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login", {
      waitUntil: "domcontentloaded",
    });

    // 3) tela de busca simples por marca (classe básica)
    await page.goto("https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp", {
      waitUntil: "domcontentloaded",
    });

    // 4) preencher e submeter
    await page.waitForSelector('input[name="marca"]', { timeout: 15000 });
    await page.click('input[name="marca"]', { clickCount: 3 });
    await page.type('input[name="marca"]', marca);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
      page.click('input[name="botao"]'),
    ]);

    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

app.post("/consulta-inpi", async (req, res) => {
  try {
    const marca = String(req.body?.marca || "").trim();
    if (!marca || marca.length < 2) {
      return res.status(400).json({ ok: false, error: "Invalid 'marca'" });
    }

    const html = await fetchInpiHtmlByMarca(marca);

    return res.status(200).json({
      ok: true,
      marca,
      html,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`INPI API running on port ${PORT}`);
});
