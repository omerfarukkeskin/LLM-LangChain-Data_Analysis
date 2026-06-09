from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import os
import shutil
import logging
import re
import time
from langchain_ollama import OllamaLLM

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL    = os.getenv("OLLAMA_MODEL", "llama3.1")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
)

UPLOAD_DIR = "temp_data"
if not os.path.exists(UPLOAD_DIR):
    os.makedirs(UPLOAD_DIR)

# ─────────────────────────────────────────────
# In-memory stores (reset on server restart)
# ─────────────────────────────────────────────

# chat_id -> file_path
chat_datasets: dict[str, str] = {}

# chat_id -> list of {"query": str, "answer": str, "timestamp": float}
chat_history: dict[str, list[dict]] = {}


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def save_turn_to_memory(chat_id: str, query: str, answer: str, file_path: str = ""):
    """Save one Q&A turn to in-memory history."""
    if chat_id not in chat_history:
        chat_history[chat_id] = []
    chat_history[chat_id].append({
        "query": query,
        "answer": answer,
        "file_path": file_path,
        "timestamp": time.time(),
    })


def get_relevant_history(chat_id: str, n: int = 4) -> str:
    """Return the last N conversation turns for context."""
    turns = chat_history.get(chat_id, [])
    recent = turns[-n:] if len(turns) > n else turns
    if not recent:
        return ""
    parts = [f"Kullanıcı: {t['query']}\nAsistan: {t['answer']}" for t in recent]
    return "\n---\n".join(parts)


def get_df_context(df: pd.DataFrame) -> str:
    """Build a rich, concise context string about the dataframe."""
    lines = []
    lines.append(f"Satır sayısı: {len(df)}, Sütun sayısı: {len(df.columns)}")
    lines.append(f"Sütunlar: {', '.join(df.columns.tolist())}")

    col_info = []
    for col in df.columns:
        dtype = str(df[col].dtype)
        nulls = int(df[col].isnull().sum())
        if pd.api.types.is_numeric_dtype(df[col]):
            col_info.append(
                f"  - {col} (sayısal, boş: {nulls}, "
                f"toplam: {df[col].sum():.4f}, "
                f"ortalama: {df[col].mean():.4f}, "
                f"min: {df[col].min():.4f}, "
                f"max: {df[col].max():.4f}, "
                f"std: {df[col].std():.4f}, "
                f"medyan: {df[col].median():.4f})"
            )
        else:
            unique_vals = df[col].dropna().unique().tolist()[:20]
            col_info.append(
                f"  - {col} (kategorik, boş: {nulls}, "
                f"benzersiz değer sayısı: {df[col].nunique()}, "
                f"benzersiz değerler: {unique_vals})"
            )
    lines.append("Sütun detayları:\n" + "\n".join(col_info))

    try:
        sample = df.head(3).to_string(index=False)
        lines.append(f"İlk 3 satır örneği:\n{sample}")
    except Exception:
        pass

    return "\n".join(lines)


TURKISH_CHARS = set("çÇğĞıİöÖşŞüÜ")
TURKISH_WORDS = {
    "ve", "bir", "bu", "da", "de", "ne", "mi", "mu", "mı", "mü",
    "kaç", "nasıl", "neden", "nerede", "kim", "hangi", "var", "yok",
    "olan", "ile", "için", "ama", "fakat", "veya", "değil", "gibi",
    "veri", "sütun", "satır", "ortalama", "toplam", "sayı", "analiz",
    "nedir", "kaçtır", "göster", "listele", "bul", "hesapla",
}


def detect_language(text: str) -> str:
    """Returns 'Turkish' or 'English' (safe fallback)."""
    if any(ch in TURKISH_CHARS for ch in text):
        return "Turkish"
    words = set(re.sub(r"[^\w\s]", "", text.lower()).split())
    if len(words & TURKISH_WORDS) >= 1:
        return "Turkish"
    return "English"


def is_off_topic(df: pd.DataFrame, query: str) -> bool:
    """Returns True if the query has no relation to the uploaded dataset."""
    query_lower = query.lower()

    greeting_keywords = ["hello", "hi", "merhaba", "selam", "hey", "naber", "nasılsın"]
    if any(kw in query_lower for kw in greeting_keywords):
        return False

    col_mentions = [col for col in df.columns if col.lower() in query_lower]
    if col_mentions:
        return False

    analysis_keywords = [
        "veri", "sütun", "satır", "ortalama", "toplam", "maksimum", "minimum",
        "medyan", "standart", "dağılım", "frekans", "sayı", "kaç", "analiz",
        "grafik", "tablo", "istatistik", "korelasyon", "boş", "eksik",
        "benzersiz", "tekrar", "kategori", "filtre", "sırala",
        "data", "column", "row", "mean", "average", "sum", "total", "max",
        "min", "median", "std", "distribution", "frequency", "count", "how many",
        "analysis", "chart", "table", "statistic", "correlation", "missing",
        "null", "unique", "category", "filter", "sort", "dataset", "file",
    ]
    if any(kw in query_lower for kw in analysis_keywords):
        return False

    return True


def get_off_topic_reply(query: str) -> str:
    """Return a polite refusal in the same language as the query."""
    ascii_ratio = sum(c.isascii() and c.isalpha() for c in query) / max(len(query), 1)
    if ascii_ratio > 0.75:
        return (
            "I can only answer questions about the uploaded dataset. "
            "Your question doesn't seem to be related to the data. "
            "Please ask something about the columns, rows, or statistics of your file."
        )
    return (
        "Yalnızca yüklenen veri seti hakkındaki soruları yanıtlayabilirim. "
        "Sorunuz veriyle ilgili görünmüyor. "
        "Lütfen dosyanızdaki sütunlar, satırlar veya istatistikler hakkında bir soru sorun."
    )


def compute_exact_answer(df: pd.DataFrame, query: str):
    """
    Returns (llm_context, direct_answer).
    - llm_context: numeric result to pass to LLM for explanation
    - direct_answer: categorical result to return directly WITHOUT calling LLM
    """
    query_lower = query.lower()
    llm_context_parts = []
    direct_parts = []

    mentioned_cols = [col for col in df.columns if col.lower() in query_lower]

    for col in mentioned_cols:
        if not pd.api.types.is_numeric_dtype(df[col]):
            continue
        series = df[col].dropna()

        if any(kw in query_lower for kw in ["toplam", "sum", "toplamı", "topla"]):
            llm_context_parts.append(f"{col} sütununun toplamı: {series.sum():.4f}")
        if any(kw in query_lower for kw in ["ortalama", "mean", "average", "ort"]):
            llm_context_parts.append(f"{col} sütununun ortalaması: {series.mean():.4f}")
        if any(kw in query_lower for kw in ["max", "maksimum", "en büyük", "en fazla"]):
            llm_context_parts.append(f"{col} sütununun maksimumu: {series.max():.4f}")
        if any(kw in query_lower for kw in ["min", "minimum", "en küçük", "en az"]):
            llm_context_parts.append(f"{col} sütununun minimumu: {series.min():.4f}")
        if any(kw in query_lower for kw in ["std", "standart sapma", "standart"]):
            llm_context_parts.append(f"{col} sütununun standart sapması: {series.std():.4f}")
        if any(kw in query_lower for kw in ["medyan", "median", "ortanca"]):
            llm_context_parts.append(f"{col} sütununun medyanı: {series.median():.4f}")
        if any(kw in query_lower for kw in ["sayı", "count", "kaç", "adet"]):
            llm_context_parts.append(f"{col} sütunundaki toplam değer sayısı: {len(series)}")

    for col in mentioned_cols:
        if pd.api.types.is_numeric_dtype(df[col]):
            continue
        series = df[col].dropna()
        if any(kw in query_lower for kw in ["unique", "benzersiz", "farklı", "tekrarsız"]):
            vals = series.unique().tolist()
            direct_parts.append(f'"{col}" sütunundaki benzersiz değerler ({len(vals)} adet): {", ".join(str(v).strip() for v in vals)}')
        if any(kw in query_lower for kw in ["sayı", "count", "kaç", "adet", "sıklık", "frekans"]):
            vc = series.value_counts()
            rows = "\n".join(f"  {str(k).strip()}: {v}" for k, v in vc.items())
            direct_parts.append(f'"{col}" sütunundaki değer dağılımı:\n{rows}')

    llm_context  = "\n".join(llm_context_parts) if llm_context_parts else ""
    direct_answer = "\n\n".join(direct_parts)    if direct_parts      else ""
    return llm_context, direct_answer


# ─────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────

@app.post("/upload")
async def upload_file(chat_id: str = Form(...), file: UploadFile = File(...)):
    file_path = os.path.join(UPLOAD_DIR, f"{chat_id}_{file.filename}")
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    chat_datasets[chat_id] = file_path

    return {"filename": file.filename, "chat_id": chat_id}


@app.get("/history/{chat_id}")
async def get_history(chat_id: str):
    """Return all stored Q&A turns for a given chat_id, ordered by timestamp."""
    turns = chat_history.get(chat_id, [])
    formatted = [
        f"Kullanıcı: {t['query']}\nAsistan: {t['answer']}"
        for t in sorted(turns, key=lambda x: x["timestamp"])
    ]
    return {"chat_id": chat_id, "history": formatted}


@app.post("/chat")
async def chat(chat_id: str = Form(...), query: str = Form(...)):
    if chat_id not in chat_datasets:
        raise HTTPException(status_code=404, detail="No dataset found for this chat")

    file_path = chat_datasets[chat_id]
    try:
        if file_path.endswith('.csv'):
            df = pd.read_csv(file_path)
        else:
            df = pd.read_excel(file_path)

        context = get_df_context(df)
        llm_context, direct_answer = compute_exact_answer(df, query)

        if direct_answer and not llm_context:
            save_turn_to_memory(chat_id, query, direct_answer, file_path)
            return {"response": direct_answer}

        if is_off_topic(df, query):
            reply = get_off_topic_reply(query)
            return {"response": reply}

        # ── Retrieve recent conversation history ──
        history_text = get_relevant_history(chat_id, n=4)

        lang = detect_language(query)
        llm  = OllamaLLM(model=OLLAMA_MODEL, base_url=OLLAMA_BASE_URL)

        history_block = (
            f"\nPREVIOUS CONVERSATION (for context only — do NOT repeat these):\n{history_text}\n"
            if history_text else ""
        )

        if llm_context:
            combined = (direct_answer + "\n\n" + llm_context).strip() if direct_answer else llm_context
            prompt = f"""You are a data analyst assistant. Reply in plain text only.

*** LANGUAGE DIRECTIVE — NON-NEGOTIABLE ***
The user's question is written in {lang}.
You MUST write your entire answer in {lang}.
Do NOT use any other language. Do NOT switch to English.
*** END DIRECTIVE ***
{history_block}
CALCULATED EXACT RESULT:
{combined}

USER QUESTION: {query}

RULES:
1. Answer in {lang} ONLY. This is mandatory and overrides everything else.
2. Use only the exact result above. Answer in 1-2 sentences.
3. Never write Python code, code blocks, or backticks (`).
4. Do not use Markdown formatting.
5. Do not alter any numbers.
6. NEVER TRANSLATE DATA VALUES. Column names, country names, category values must stay exactly as they appear in the data.

ANSWER:"""
        else:
            prompt = f"""You are a data analyst assistant. Reply in plain text only.

*** LANGUAGE DIRECTIVE — NON-NEGOTIABLE ***
The user's question is written in {lang}.
You MUST write your entire answer in {lang}.
Do NOT use any other language. Do NOT switch to English.
*** END DIRECTIVE ***
{history_block}
DATASET INFORMATION:
{context}

USER QUESTION: {query}

RULES:
1. Answer in {lang} ONLY. This is mandatory and overrides everything else.
2. Use the dataset information to answer in 1-3 sentences.
3. Never write Python code, code blocks, or backticks (`).
4. Do not use Markdown formatting.
5. NEVER TRANSLATE DATA VALUES. Column names, country names, category values must stay exactly as they appear in the data.

ANSWER:"""

        raw_response = llm.invoke(prompt)

        clean = re.sub(r"```[\s\S]*?```", "", str(raw_response))
        clean = re.sub(r"`[^`]*`", "", clean)
        clean = clean.strip()

        # ── Save this turn to in-memory history ──
        save_turn_to_memory(chat_id, query, clean, file_path)

        return {"response": clean}

    except Exception:
        logger.error("An error occurred while processing the chat request.")
        raise HTTPException(status_code=500, detail="An internal error occurred. Please try again.")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
