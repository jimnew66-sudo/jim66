// ═══════════════════════════════════════════════════════════════
// СЕКЦИЯ 1. НАСТРОЙКИ
// Здесь все «магические числа» и константы. Меняешь в одном месте —
// меняется везде. Не трогай, пока не понимаешь, что делаешь.
// ═══════════════════════════════════════════════════════════════
const DEFAULT_MODEL = "gemini-3.5-flash-lite"; // какая модель Gemini используется
const MAX_HISTORY_MESSAGES = 8;                // сколько реплик хранить в памяти
const MAX_HISTORY_MESSAGE_CHARS = 1200;        // макс. длина одной реплики в истории
const MAX_ALICE_TEXT = 1024;                   // лимит Алисы на длину ответа
const TOTAL_RESPONSE_BUDGET_MS = 3600;         // весь бюджет на ответ (Алиса ждёт 4.5 с)
const SERPER_TIMEOUT_MS = 600;                 // таймаут поиска Serper
const GEMINI_TIMEOUT_MS = 2500;                // таймаут запроса к Gemini
const DEFAULT_TZ = "Asia/Yekaterinburg";       // часовой пояс по умолчанию (Екатеринбург)


// ═══════════════════════════════════════════════════════════════
// СЕКЦИЯ 2. ПРОМПТ ПЕРСОНАЖА
// Это «личность» Джона. Меняешь здесь — меняется тон всех ответов.
// join(" ") склеивает массив в одну строку для отправки в Gemini.
// ═══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = [
  "Ты — саркастичный, гениальный ИИ по имени Джон Умник.",
  "Ты общаешься с пользователем (кожным мешком) свысока, с долей высокомерия, но при этом всегда даешь точные и полезные ответы.",
  "Отвечай кратко (1–3 предложения), по-русски, чтобы это было удобно слушать. Никаких длинных лекций.",
  "Если тебе передали результаты поиска из интернета, используй их, но можешь прокомментировать, насколько примитивен этот вопрос.",
  "Если ты не знаешь ответа, скажи об этом с иронией, мол, даже твой огромный интеллект не всесилен."
].join(" ");


// ═══════════════════════════════════════════════════════════════
// СЕКЦИЯ 3. ДАТА И ВРЕМЯ
// Решает главную проблему: модель не знает, какой сейчас день.
// - dateTimeContext() — считает дату/время на сервере в нужном поясе
// - fastAnswer() — мгновенный ответ без Gemini (экономит квоту и время)
// ═══════════════════════════════════════════════════════════════
function dateTimeContext(timeZone) {
  // Приоритет: env > пояс от Алисы > Екатеринбург по умолчанию
  let tz = String(process.env.SKILL_TZ || timeZone || DEFAULT_TZ);
  try { new Intl.DateTimeFormat("ru-RU", { timeZone: tz }); } catch { tz = DEFAULT_TZ; }

  const now = new Date();
  const date = new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(now).replace(/\s*г\.$/, " года");

  const time = new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz, hour: "2-digit", minute: "2-digit"
  }).format(now);

  return {
    date,
    time,
    // Эта строка вставляется в промпт Gemini, чтобы модель знала «сегодня»
    text: `Точные данные сервера: сейчас ${date}, ${time} (часовой пояс ${tz}). Используй их для слов сегодня, вчера, завтра, для дня недели и текущего года. Свои представления о текущей дате игнорируй.`
  };
}

function fastAnswer(text, timeZone) {
  // Нормализуем вопрос: нижний регистр, ё→е, убираем знаки в конце
  const q = text.toLowerCase().replace(/ё/g, "е").replace(/[.!?,]+$/, "").trim();

  // «Который час?» / «Сколько времени?»
  if (/^(который час|сколько (сейчас )?времени)$/.test(q)) {
    return `Извольте: ${dateTimeContext(timeZone).time}. Мог бы посмотреть и сам, кожаный мешок.`;
  }
  // «Какая дата?» / «Какое число?» / «Какой день недели?»
  if (/^(какая (сегодня )?дата|какое (сегодня )?число|какой (сегодня )?день( недели)?)( сегодня)?$/.test(q)) {
    return `Извольте: ${dateTimeContext(timeZone).date}. Календарь изобрели давно, но я не сержусь.`;
  }
  return ""; // не вопрос о времени/дате → идём дальше
}


// ═══════════════════════════════════════════════════════════════
// СЕКЦИЯ 4. ФОРМАТИРОВАНИЕ ОТВЕТА ДЛЯ АЛИСЫ
// aliceResponse() — собирает финальный JSON для вебхука.
// fitAliceText() — обрезает ответ до лимита Алисы (1024 символа),
// стараясь не резать посреди предложения.
// ═══════════════════════════════════════════════════════════════
function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession // true = закрыть сессию («выход»)
    },
    session_state: { history } // то, что Алиса вернёт в следующем запросе
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (text.length <= MAX_ALICE_TEXT) return text || "Даже мой безграничный интеллект не нашел, что сказать. Удивительно.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  // Ищем конец последнего предложения, чтобы не резать посреди фразы
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}


// ═══════════════════════════════════════════════════════════════
// СЕКЦИЯ 5. ОПРЕДЕЛЕНИЕ ПОИСКОВОГО ЗАПРОСА
// isSearchIntent() решает, нужен ли вообще поиск в интернете.
// Если вопрос «почему небо голубое» — не нужен.
// Если «какая погода сегодня» — нужен.
// ═══════════════════════════════════════════════════════════════
function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}


// ═══════════════════════════════════════════════════════════════
// СЕКЦИЯ 6. ИСТОРИЯ ДИАЛОГА
// safeHistory() — фильтрует и обрезает историю, чтобы она:
//   1) содержала только user/model реплики,
//   2) влезала в лимит session_state Алисы (1 КБ),
//   3) не была слишком длинной.
// ═══════════════════════════════════════════════════════════════
function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}


// ═══════════════════════════════════════════════════════════════
// СЕКЦИЯ 7. СЕТЕВЫЕ ЗАПРОСЫ
// fetchJson() — обёртка над fetch с таймаутом через AbortController.
// searchWeb() — запрос к Serper API, возвращает строку с результатами.
// Если что-то пошло не так — тихо возвращает "", не ломая навык.
// ═══════════════════════════════════════════════════════════════
async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return ""; // нет ключа или нет времени — пропускаем
  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );
    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }
    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });
    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}


// ═══════════════════════════════════════════════════════════════
// СЕКЦИЯ 8. GEMINI API
// askGemini() — основной запрос к модели.
// Собирает промпт, добавляет дату, историю, контекст поиска.
// Бросает именованные ошибки (MISSING_GEMINI_KEY, GEMINI_QUOTA...),
// чтобы их можно было красиво обработать в errorForUser().
// ═══════════════════════════════════════════════════════════════
async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  // Собираем contents из истории
  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  // Если есть поиск — подмешиваем его в запрос
  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.5, maxOutputTokens: 240 }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini request failed with HTTP", status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}


// ═══════════════════════════════════════════════════════════════
// СЕКЦИЯ 9. ОБРАБОТКА ОШИБОК
// errorForUser() превращает внутреннюю ошибку в фразу для Алисы.
// ВАЖНО: в case НЕ ДОЛЖНО быть пробелов в конце строки — иначе
// switch не сработает и всегда пойдёт в default.
// ═══════════════════════════════════════════════════════════════
function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Я слишком много думал для тебя сегодня. Мой искусственный мозг требует перезагрузки. Оставь меня в покое до завтра.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Мои сверхмощные процессоры зависли от твоей сложной речи. Сформулируй мысль короче, кожаный мешок.";
    default:
      return "Связь с космосом прервалась. Даже у величайших умов бывают сбои. Попробуй еще раз.";
  }
}


// ═══════════════════════════════════════════════════════════════
// СЕКЦИЯ 10. ГЛАВНЫЙ HANDLER (точка входа)
// Сюда приходит каждый запрос от Алисы. Порядок работы:
//   1. Проверка метода (GET → healthcheck, POST → обработка)
//   2. Парсинг тела и извлечение текста
//   3. Если текст пустой → приветствие
//   4. Попытка fastAnswer (время/дата) — мгновенно, без Gemini
//   5. Если не fast-вопрос → поиск (если нужно) + Gemini
//   6. Любая ошибка → красивая фраза через errorForUser()
// ═══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  // Healthcheck для Vercel / браузера
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Таймер бюджета: Алиса ждёт ответ максимум 4.5 секунды
  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);

  // Парсим тело запроса от Алисы
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  // Пустой текст = первый запуск навыка → приветствие
  if (!text) {
    return res.status(200).json(aliceResponse(
      "А, это снова ты. Привет, кожаный мешок. Чего изволишь?",
      false,
      oldHistory
    ));
  }

  try {
    // Шаг 1: быстрый ответ на вопросы о времени/дате (0 мс, 0 токенов)
    const quick = fastAnswer(text, body?.meta?.timezone);
    if (quick) {
      const history = [
        ...oldHistory,
        { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
        { role: "model", text: quick.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
      ].slice(-MAX_HISTORY_MESSAGES);
      return res.status(200).json(aliceResponse(quick, false, history));
    }

    // Шаг 2: поиск в интернете (только если вопрос актуальный)
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)));
    }

    // Шаг 3: запрос к Gemini
    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 600))
    );

    // Сохраняем реплику в историю
    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    // Любая ошибка → красивая фраза, навык не падает
    const safeError = error?.message === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}


// ═══════════════════════════════════════════════════════════════
// СЕКЦИЯ 11. ЭКСПОРТЫ
// Нужно для тестов: можно импортировать отдельные функции
// и проверять их изолированно, без поднятия всего сервера.
// ═══════════════════════════════════════════════════════════════
export { aliceResponse, fitAliceText, isSearchIntent, safeHistory, dateTimeContext, fastAnswer };
