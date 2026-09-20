/**
 * 自定义题库的输入规范化与内容指纹（Web / App / Node 共用）。
 *
 * 这里只做纯数据处理，不负责写数据库。服务端和本地 handler 据此处理
 * 幂等、冲突和版本；使用 Web Crypto 可用时生成 UUID，避免本地 App 依赖
 * Node-only 模块。
 */
import { normalizeAnswer } from './custom-parser.js';

export const ANSWER_STATUSES = new Set(['confirmed', 'unconfirmed', 'missing', 'disputed']);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TEXT = 200000;
const MAX_IMAGES = 6;
const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function text(value, max = MAX_TEXT) {
  return String(value ?? '').trim().slice(0, max);
}

function makeQuestionUid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

// 同步 SHA-256，保证离线 App 与服务端使用完全相同的题目指纹。
function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(total);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(total - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(total - 4, bitLength >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
}

function parseOptions(value) {
  if (!Array.isArray(value)) return null;
  return value.map((item) => text(item, 20000)).filter(Boolean);
}

function parseImages(value, errors, index) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    errors.push({ index, code: 'images_not_array', field: 'images', message: 'images 必须是数组' });
    return [];
  }
  const images = [];
  for (let i = 0; i < value.length && images.length < MAX_IMAGES; i++) {
    const item = value[i];
    const role = item && String(item.role || '').trim();
    const dataUrl = item && String(item.dataUrl || '').trim();
    if (!item || !['stem', 'material'].includes(role) || !/^data:image\//i.test(dataUrl)) {
      errors.push({ index, code: 'invalid_image', field: `images[${i}]`, message: '图片必须是 stem/material 角色的 data:image 数据' });
      continue;
    }
    if (dataUrl.length > 15 * 1024 * 1024) {
      errors.push({ index, code: 'image_too_large', field: `images[${i}]`, message: '单张图片超过 15 MB' });
      continue;
    }
    images.push({ role, dataUrl });
  }
  if (value.length > MAX_IMAGES) errors.push({ index, code: 'too_many_images', field: 'images', message: `单题最多 ${MAX_IMAGES} 张图片` });
  return images;
}

function normalizeAnswerInput(rawAnswer, options, suppliedIndex) {
  const normalized = normalizeAnswer(rawAnswer, options);
  let answer = text(normalized.answer);
  const hasSuppliedIndex = suppliedIndex !== null && suppliedIndex !== undefined && String(suppliedIndex).trim() !== '';
  let answerIndex = hasSuppliedIndex && Number.isInteger(Number(suppliedIndex)) ? Number(suppliedIndex) : Number(normalized.answer_index);
  if (!Number.isInteger(answerIndex)) answerIndex = -1;
  if (!answer && answerIndex >= 0) answer = String(answerIndex);
  return { answer, answerIndex, options: normalized.options };
}

export function customQuestionFingerprint(question) {
  const options = Array.isArray(question.options) ? question.options.map((v) => text(v, 20000)) : [];
  const images = Array.isArray(question.images)
    ? question.images.map((im) => ({ role: text(im?.role, 20), dataUrl: text(im?.dataUrl, 15 * 1024 * 1024) }))
    : [];
  const payload = {
    prompt: text(question.prompt),
    material: text(question.material),
    options,
    answer: text(question.answer),
    answer_index: Number.isInteger(Number(question.answer_index)) ? Number(question.answer_index) : -1,
    analysis: text(question.analysis),
    category: text(question.category, 100),
    images,
  };
  return sha256(JSON.stringify(payload));
}

export function normalizeCustomQuestion(raw, index = 0) {
  const errors = [];
  const q = raw && typeof raw === 'object' ? raw : {};
  const optionsInput = q.options == null ? [] : parseOptions(q.options);
  if (optionsInput == null) errors.push({ index, code: 'options_not_array', field: 'options', message: 'options 必须是数组' });
  const options = optionsInput || [];
  if (options.length > 26) errors.push({ index, code: 'too_many_options', field: 'options', message: '单题最多 26 个选项' });
  const images = parseImages(q.images, errors, index);
  const normalizedAnswer = normalizeAnswerInput(q.answer, options, q.answer_index);
  const answer = normalizedAnswer.answer;
  const answerIndex = normalizedAnswer.answerIndex;
  const prompt = text(q.prompt);
  const material = text(q.material);
  const analysis = text(q.analysis);
  const category = text(q.category, 100);
  const rawExternalId = String(q.external_id ?? q.externalId ?? q.source_id ?? q.sourceId ?? '').trim();
  const externalId = rawExternalId.slice(0, 256);
  const rawUid = String(q.question_uid ?? q.questionUid ?? q.uid ?? '').trim();
  const requestedUid = rawUid.slice(0, 128);
  const questionUid = requestedUid || makeQuestionUid();
  const requestedAnswerStatus = String(q.answer_status || '').trim();
  const answerStatus = ANSWER_STATUSES.has(requestedAnswerStatus)
    ? requestedAnswerStatus
    : (answer || answerIndex >= 0 ? 'unconfirmed' : 'missing');

  if (!prompt && images.length === 0) errors.push({ index, code: 'empty_question', field: 'prompt', message: '题目至少需要 prompt 或题干图片' });
  if (rawUid.length > 128 || (requestedUid && !ID_RE.test(requestedUid))) errors.push({ index, code: 'invalid_question_uid', field: 'question_uid', message: 'question_uid 只能包含字母、数字和 . _ : -，长度不超过 128' });
  if (rawExternalId.length > 256) errors.push({ index, code: 'external_id_too_long', field: 'external_id', message: 'external_id 长度不超过 256' });
  if (requestedAnswerStatus && !ANSWER_STATUSES.has(requestedAnswerStatus)) errors.push({ index, code: 'invalid_answer_status', field: 'answer_status', message: 'answer_status 必须是 confirmed/unconfirmed/missing/disputed 之一' });
  if (answerIndex < -1 || (options.length > 0 && answerIndex >= options.length)) errors.push({ index, code: 'answer_index_out_of_range', field: 'answer_index', message: 'answer_index 不在选项范围内' });
  if (answer.startsWith('[')) {
    try {
      const parsed = JSON.parse(answer);
      const values = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed[0] : parsed;
      if (!Array.isArray(values) || values.some((v) => !Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) >= options.length)) {
        errors.push({ index, code: 'answer_indices_out_of_range', field: 'answer', message: '多选答案索引不在选项范围内' });
      }
    } catch {
      errors.push({ index, code: 'invalid_answer_json', field: 'answer', message: '多选答案不是合法 JSON 数组' });
    }
  }
  const question = {
    question_uid: questionUid,
    _question_uid_explicit: Boolean(requestedUid),
    external_id: externalId,
    _external_id_explicit: Boolean(externalId),
    revision: 1,
    is_current: 1,
    prompt,
    material,
    options: normalizedAnswer.options,
    answer,
    answer_index: answerIndex,
    answer_status: answerStatus,
    analysis,
    category,
    images,
    material_id: text(q.material_id, 256),
  };
  question.fingerprint = customQuestionFingerprint(question);
  return { question, errors };
}

export function normalizeCustomQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return { questions: [], errors: [{ index: -1, code: 'questions_not_array', field: 'questions', message: 'questions 必须是数组' }] };
  const questions = [];
  const errors = [];
  rawQuestions.forEach((raw, index) => {
    const result = normalizeCustomQuestion(raw, index);
    questions.push(result.question);
    errors.push(...result.errors);
  });
  if (questions.length === 0) errors.push({ index: -1, code: 'empty_questions', field: 'questions', message: 'questions 不能为空' });
  return { questions, errors };
}
