// src/llm/embeddings.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

/**
 * 한글/영문 기준 토크나이저
 * - 소문자 변환
 * - 한글, 영문, 숫자만 남기고 나머지는 구분자로 본다.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
    const t = String(text || "").toLowerCase();
    const replaced = t.replace(/[^0-9a-z\uac00-\ud7a3]+/gi, " ");
    const tokens = replaced.split(/\s+/).filter(Boolean);
    return tokens;
  }
  
  /**
   * TF 값을 계산한다.
   * @param {string[]} tokens
   * @returns {Map<string, number>}
   */
  function termFrequency(tokens) {
    const tf = new Map();
    if (!tokens.length) return tf;
  
    for (const tok of tokens) {
      tf.set(tok, (tf.get(tok) || 0) + 1);
    }
  
    const total = tokens.length;
    for (const [k, v] of tf.entries()) {
      tf.set(k, v / total);
    }
    return tf;
  }
  
  /**
   * DF(문서 빈도) 맵을 만든다.
   * @param {Array<{ id: string, text: string }>} docs
   * @returns {Map<string, number>}
   */
  function documentFrequency(docs) {
    const df = new Map();
  
    for (const doc of docs) {
      const tokens = new Set(tokenize(doc.text));
      for (const tok of tokens) {
        df.set(tok, (df.get(tok) || 0) + 1);
      }
    }
  
    return df;
  }
  
  /**
   * 코사인 유사도
   * @param {number[]} a
   * @param {number[]} b
   * @returns {number}
   */
  export function cosineSimilarity(a, b) {
    if (!a.length || !b.length || a.length !== b.length) return 0;
  
    let dot = 0;
    let na = 0;
    let nb = 0;
  
    for (let i = 0; i < a.length; i++) {
      const va = a[i];
      const vb = b[i];
      dot += va * vb;
      na += va * va;
      nb += vb * vb;
    }
  
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
  
  /**
   * TF-IDF 인덱스 구조체
   * @typedef {Object} TfidfIndex
   * @property {string[]} vocab
   * @property {Map<string, number>} idf
   * @property {Array<{ id: string, vector: number[] }>} docVectors
   */
  
  /**
   * 주어진 문서 집합으로 TF-IDF 인덱스 생성
   * @param {Array<{ id: string, text: string }>} docs
   * @returns {TfidfIndex}
   */
  export function buildTfidfIndex(docs) {
    const df = documentFrequency(docs);
    const N = docs.length || 1;
  
    const vocab = Array.from(df.keys());
    const idf = new Map();
    for (const [term, freq] of df.entries()) {
      const val = Math.log((N + 1) / (freq + 1)) + 1;
      idf.set(term, val);
    }
  
    const docVectors = docs.map((doc) => {
      const tokens = tokenize(doc.text);
      const tf = termFrequency(tokens);
      const vec = vocab.map((term) => (tf.get(term) || 0) * (idf.get(term) || 0));
      return { id: doc.id, vector: vec };
    });
  
    return { vocab, idf, docVectors };
  }
  
  /**
   * 주어진 텍스트를 기존 TF-IDF 인덱스 기준으로 벡터화
   * @param {string} text
   * @param {TfidfIndex} index
   * @returns {number[]}
   */
  export function vectorize(text, index) {
    const tokens = tokenize(text);
    const tf = termFrequency(tokens);
    const { vocab, idf } = index;
    const vec = vocab.map((term) => (tf.get(term) || 0) * (idf.get(term) || 0));
    return vec;
  }
  