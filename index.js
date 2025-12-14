import express from "express";
import cors from "cors";
import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";

// --------------------
// Config
// --------------------
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (!INTERNAL_API_TOKEN) {
  throw new Error("Missing env var INTERNAL_API_TOKEN");
}

const SUPABASE_PROJECT_URL = "https://mqnvfjteuwqbomvbmyhd.supabase.co"
const PORT = process.env.PORT || 3000;

// --------------------
// Express app
// --------------------
const app = express();
app.use(express.json({ limit: "200kb" }));

// CORS defensivo:
// - permite requests sem Origin (server-to-server, comum em Edge Functions)
// - permite apenas o seu SUPABASE_PROJECT_URL quando houver Origin (caso alguém tente via browser)
// Observação: CORS NÃO é segurança. Segurança real é o token abaixo.
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server
      if (SUPABASE_PROJECT_URL && origin === SUPABASE_PROJECT_URL) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Internal-Token"],
    maxAge: 86400
  })
);

// Preflight
app.options("*", (req, res) => res.sendStatus(204));

// Middleware de autenticação por token (segurança real)
app.use((req, res, next) => {
  const token = req.header("X-Internal-Token");
  if (token !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Healthcheck (também protegido)
app.get("/health", (req, res) => res.json({ ok: true }));

// --------------------
// INPI scraper (sessionful)
// --------------------
async function fetchInpiHtmlByMarca(marca) {
  const jar = new CookieJar();

  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      timeout: 20000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      },
      // se o INPI responder 302/403, a gente ainda quer ver e diagnosticar
      validateStatus: () => true
    })
  );

  // 1) Abre a home (/pePI/) — frequentemente já seta JSESSIONID + BUSCAID
  const r1 = await client.get("https://busca.inpi.gov.br/pePI/");
  if (r1.status >= 400) {
    throw new Error(`INPI step1 failed: status=${r1.status}`);
  }

  // 2) Simula "acesso anônimo"
  const r2 = await client.get(
    "https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login"
  );
  if (r2.status >= 400) {
    throw new Error(`INPI step2 failed: status=${r2.status}`);
  }

  // 3) Abre a página de busca (ajuda o backend a preparar estado)
  const r3 = await client.get(
    "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp"
  );
  if (r3.status >= 400) {
    throw new Error(`INPI step3 failed: status=${r3.status}`);
  }

  // 4) POST do formulário (o que o browser faz)
  const form = new URLSearchParams({
    buscaExata: "sim",
    txt: "",
    marca,
    classeInter: "",
    registerPerPage: "20",
    botao: "+pesquisar+%BB+",
    Action: "searchMarca",
    tipoPesquisa: "BY_MARCA_CLASSIF_BASICA"
  });

  const r4 = await client.post(
    "https://busca.inpi.gov.br/pePI/servlet/MarcasServletController",
    form.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://busca.inpi.gov.br",
        Referer:
          "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp"
      }
    }
  );

  const html = typeof r4.data === "string" ? r4.data : "";
  if (!html || html.length < 200) {
    throw new Error(`INPI step4 returned empty/short html. status=${r4.status}`);
  }

  // Sinais típicos de página de resultado (pra sanity check)
  const ok =
    html.includes("RESULTADO DA PESQUISA") ||
    /Foram encontrados?\s*\d+\s*processos?/i.test(html) ||
    html.toLowerCase().includes("nenhum resultado");

  if (!ok) {
    // ainda retorna, mas sinaliza possível página inesperada
    return { html, warning: "HTML returned but does not look like result page", status: r4.status };
  }

  return { html, status: r4.status };
}

// --------------------
// API endpoint
// --------------------
app.post("/consulta-inpi", async (req, res) => {
  try {
    const marca = String(req.body?.marca || "").trim();
    if (!marca || marca.length < 2) {
      return res.status(400).json({ error: "Invalid 'marca'" });
    }

    const out = await fetchInpiHtmlByMarca(marca);
    // Retorna HTML bruto (como você pediu)
    return res.status(200).json({
      ok: true,
      marca,
      status: out.status,
      warning: out.warning || null,
      html: out.html
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error"
    });
  }
});

app.listen(PORT, () => {
  console.log(`INPI proxy listening on :${PORT}`);
});
