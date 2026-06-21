/**
 * scoring.ts — Smart Locator Scoring System
 *
 * Each candidate element is scored 0–100 against the user's intent (targetText).
 * Multiple scoring signals are combined; the element with the highest total score wins.
 */

export interface ScoringContext {
  /** Target text extracted from the test step (already lowercased & normalised) */
  targetText: string;
  /** Original raw target text before normalisation (for partial word matching) */
  rawTarget: string;
}

export interface ElementAttributes {
  id: string;
  name: string;
  type: string;
  placeholder: string;
  ariaLabel: string;
  ariaDescribedby: string;
  labelText: string;
  elementText: string;
  classNames: string;
  tagName: string;
  role: string;
  title: string;
  dataTestId: string;
  value: string;
  autocomplete: string;
  // Advanced features fields
  helpText?: string;
  errorText?: string;
  nearbyText?: string[];
  position?: number;
  totalFieldsInForm?: number;
  isVisible?: boolean;
}

export interface ScoreResult {
  score: number;
  /** Which signal contributed the highest score */
  winningSignal: string;
}

// ---------------------------------------------------------------------------
// Fuzzy Matching & Typo Tolerance (Levenshtein Distance)
// ---------------------------------------------------------------------------

/** Calculate Levenshtein distance between two strings */
export function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  for (let i = 0; i <= s2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= s1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= s2.length; i++) {
    for (let j = 1; j <= s1.length; j++) {
      if (s2[i - 1] === s1[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // deletion
          matrix[i - 1][j] + 1      // insertion
        );
      }
    }
  }

  return matrix[s2.length][s1.length];
}

/** Calculate similarity percentage (0-100) */
export function calculateSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  if (str1.toLowerCase() === str2.toLowerCase()) return 100;
  const distance = levenshteinDistance(str1, str2);
  const maxLength = Math.max(str1.length, str2.length);
  return Math.round(((maxLength - distance) / maxLength) * 100);
}

/** Check if strings are similar enough to match based on threshold (0-100) */
export function fuzzyMatch(str1: string, str2: string, threshold: number = 80): boolean {
  return calculateSimilarity(str1, str2) >= threshold;
}

// ---------------------------------------------------------------------------
// Multi-Language Translations Mappings
// ---------------------------------------------------------------------------

export const TRANSLATIONS: Record<string, Record<string, string[]>> = {
  es: {
    email: ['correo', 'electronico', 'email', 'dirección', 'dirección de correo', 'mail'],
    password: ['contraseña', 'clave', 'contrasena', 'contrasinal'],
    username: ['usuario', 'nombre', 'login', 'apodo', 'cuenta'],
    phone: ['teléfono', 'telefono', 'móvil', 'movil', 'celular'],
    submit: ['enviar', 'entrar', 'ingresar', 'conectar', 'iniciar', 'guardar', 'siguiente'],
    search: ['buscar', 'búsqueda', 'consulta', 'encontrar'],
  },
  fr: {
    email: ['courrier', 'courriel', 'email', 'adresse', 'mail', 'mel'],
    password: ['mot', 'passe', 'motdepasse', 'secret'],
    username: ['identifiant', 'utilisateur', 'nom', 'compte'],
    phone: ['téléphone', 'telephone', 'portable', 'mobile'],
    submit: ['envoyer', 'connecter', 'soumettre', 'enregistrer', 'suivant', 'valider'],
    search: ['rechercher', 'recherche', 'trouver'],
  },
  de: {
    email: ['email', 'mail', 'adresse', 'e-mailadresse'],
    password: ['passwort', 'kennwort', 'code'],
    username: ['benutzername', 'benutzer', 'login', 'konto'],
    phone: ['telefon', 'rufnummer', 'mobil', 'handy'],
    submit: ['anmelden', 'senden', 'einloggen', 'speichern', 'weiter', 'bestätigen'],
    search: ['suchen', 'suche', 'finden'],
  },
  pt: {
    email: ['correio', 'email', 'endereco', 'e-mail'],
    password: ['senha', 'palavra-passe', 'codigo'],
    username: ['usuario', 'utilizador', 'nome', 'login', 'conta'],
    phone: ['telefone', 'telemovel', 'celular', 'movel'],
    submit: ['enviar', 'entrar', 'login', 'guardar', 'salvar', 'proximo'],
    search: ['procurar', 'pesquisar', 'busca', 'encontrar'],
  }
};

// ---------------------------------------------------------------------------
// Semantic Dictionary and Keyword Mappings
// ---------------------------------------------------------------------------

export interface KeywordMapping {
  primary: string[];
  synonyms: string[];
  weight: number;
  context: string[];
  types: string[];
}

export const SEMANTIC_DICTIONARY: Record<string, KeywordMapping> = {
  email: {
    primary: ['email', 'e-mail', 'mail', 'emailaddress'],
    synonyms: ['contact', 'address', 'electronic', 'gmail', 'outlook', 'sender', 'recipient', 'login', 'username', 'user'],
    weight: 100,
    context: ['login', 'signup', 'registration', 'account', 'subscribe', 'contact'],
    types: ['email', 'text']
  },
  password: {
    primary: ['password', 'pwd', 'pass', 'secret', 'passphrase', 'passwd'],
    synonyms: ['credential', 'authentication', 'security', 'pin', 'passcode'],
    weight: 100,
    context: ['login', 'authentication', 'secure', 'auth', 'signin'],
    types: ['password']
  },
  username: {
    primary: ['username', 'user', 'login', 'account name', 'userid'],
    synonyms: ['handle', 'name', 'account', 'identity', 'user id'],
    weight: 90,
    context: ['login', 'signup', 'account', 'profile', 'authentication'],
    types: ['text', 'username']
  },
  phone: {
    primary: ['phone', 'telephone', 'mobile', 'cell', 'phone number'],
    synonyms: ['contact', 'number', 'tel', 'digits'],
    weight: 85,
    context: ['contact', 'support', 'account', 'billing'],
    types: ['tel', 'phone', 'text']
  },
  firstname: {
    primary: ['first name', 'firstname', 'given name', 'first', 'fname'],
    synonyms: ['name', 'given'],
    weight: 80,
    context: ['contact', 'profile', 'account', 'form'],
    types: ['text']
  },
  lastname: {
    primary: ['last name', 'lastname', 'family name', 'surname', 'last', 'lname'],
    synonyms: ['name', 'surname', 'family'],
    weight: 80,
    context: ['contact', 'profile', 'account', 'form'],
    types: ['text']
  },
  fullname: {
    primary: ['fullname', 'name', 'displayname', 'full name'],
    synonyms: ['name', 'identity', 'user name'],
    weight: 80,
    context: ['contact', 'profile', 'account', 'form'],
    types: ['text']
  },
  address: {
    primary: ['address', 'addr', 'street', 'location'],
    synonyms: ['residence', 'home', 'building'],
    weight: 75,
    context: ['billing', 'shipping', 'contact', 'account'],
    types: ['text']
  },
  city: {
    primary: ['city', 'town', 'municipality'],
    synonyms: ['location', 'district', 'suburb'],
    weight: 75,
    context: ['billing', 'shipping', 'contact'],
    types: ['text']
  },
  zip: {
    primary: ['zip', 'zipcode', 'postal', 'postcode', 'zip code', 'postal code'],
    synonyms: ['code', 'pin', 'pincode'],
    weight: 75,
    context: ['billing', 'shipping', 'contact'],
    types: ['text', 'number']
  },
  date: {
    primary: ['date', 'birthday', 'birthdate', 'expiry', 'expiration', 'expires'],
    synonyms: ['day', 'when', 'calendar', 'time'],
    weight: 75,
    context: ['form', 'account', 'billing'],
    types: ['date', 'text']
  },
  search: {
    primary: ['search', 'query', 'find', 'keywords', 'q'],
    synonyms: ['query', 'look for'],
    weight: 75,
    context: ['search', 'filter', 'lookup'],
    types: ['search', 'text']
  },
  submit: {
    primary: ['submit', 'send', 'save', 'create', 'register', 'login', 'signin', 'sign in', 'log-in', 'sign-in', 'ok', 'confirm'],
    synonyms: ['button', 'action', 'continue', 'next', 'done', 'apply'],
    weight: 70,
    context: ['form', 'action', 'complete'],
    types: ['submit', 'button']
  },
  cancel: {
    primary: ['cancel', 'close', 'dismiss', 'abort', 'back'],
    synonyms: ['quit', 'exit', 'return'],
    weight: 70,
    context: ['modal', 'form', 'action'],
    types: ['button']
  },
  checkbox: {
    primary: ['check', 'agree', 'accept', 'confirm'],
    synonyms: ['selection', 'toggle', 'option'],
    weight: 65,
    context: ['terms', 'confirmation', 'option'],
    types: ['checkbox']
  },
  dropdown: {
    primary: ['select', 'choose', 'pick', 'dropdown', 'option'],
    synonyms: ['list', 'category', 'type'],
    weight: 70,
    context: ['choice', 'category', 'filter'],
    types: ['select']
  }
};

// ---------------------------------------------------------------------------
// Backward Compatibility Exports
// ---------------------------------------------------------------------------

export const SEMANTIC_ALIASES: Record<string, string[]> = {
  email: SEMANTIC_DICTIONARY.email.synonyms,
  password: SEMANTIC_DICTIONARY.password.synonyms,
  username: SEMANTIC_DICTIONARY.username.synonyms,
  firstname: SEMANTIC_DICTIONARY.firstname.synonyms,
  lastname: SEMANTIC_DICTIONARY.lastname.synonyms,
  fullname: SEMANTIC_DICTIONARY.fullname.synonyms,
  phone: SEMANTIC_DICTIONARY.phone.synonyms,
  address: SEMANTIC_DICTIONARY.address.synonyms,
  city: SEMANTIC_DICTIONARY.city.synonyms,
  zip: SEMANTIC_DICTIONARY.zip.synonyms,
  search: SEMANTIC_DICTIONARY.search.synonyms,
  login: ['login', 'signin', 'sign-in', 'submit', 'enter', 'continue', 'log-in'],
  signup: ['signup', 'register', 'create', 'join', 'get-started'],
  submit: ['submit', 'save', 'confirm', 'ok', 'done', 'apply', 'send'],
  cancel: ['cancel', 'close', 'dismiss', 'abort', 'back'],
  logout: ['logout', 'signout', 'sign-out', 'log-out'],
  message: ['message', 'comment', 'body', 'content', 'note', 'description', 'text'],
};

export const TYPE_INFERENCE: Record<string, string> = {
  email: 'email',
  mail: 'email',
  password: 'password',
  pass: 'password',
  phone: 'tel',
  mobile: 'tel',
  number: 'number',
  date: 'date',
  time: 'time',
  file: 'file',
  upload: 'file',
  search: 'search',
  url: 'url',
  website: 'url',
  color: 'color',
  colour: 'color',
  range: 'range',
};

// Normalize a string: lowercase, strip spaces/dashes/underscores
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_\-]/g, '');
}

// Check if haystack contains needle as a full word or exact substring
function containsWord(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h.includes(n)) return true;
  try {
    return new RegExp(`\\b${n}\\b`, 'i').test(haystack);
  } catch {
    return false;
  }
}

// Returns a similarity ratio 0–1 between two strings (Dice coefficient on bigrams)
function stringSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s: string) => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const biA = bigrams(a.toLowerCase());
  const biB = bigrams(b.toLowerCase());
  const setB = new Set(biB);
  let matches = 0;
  biA.forEach(b => { if (setB.has(b)) matches++; });
  return (2 * matches) / (biA.length + biB.length);
}

// ---------------------------------------------------------------------------
// Main Scoring Function (Cumulative Multi-Layer Scorer)
// ---------------------------------------------------------------------------

export function scoreElement(attrs: ElementAttributes, ctx: ScoringContext): ScoreResult {
  const { targetText, rawTarget } = ctx;
  const target = targetText.toLowerCase().replace(/[\s_\-]+/g, ' ').trim();

  // 1. Tokenize intent
  const words = target.split(/\s+/).filter(w => w.length > 1);

  // 2. Perform translation expansion (e.g. Spanish/French -> English keyword)
  const translatedWords = new Set<string>();
  for (const word of words) {
    translatedWords.add(word);
    for (const [lang, map] of Object.entries(TRANSLATIONS)) {
      for (const [englishKey, foreignWords] of Object.entries(map)) {
        if (foreignWords.some(fw => fw === word || fuzzyMatch(fw, word, 85))) {
          translatedWords.add(englishKey);
        }
      }
    }
  }

  // 3. Initialize score segments
  let keywordScore = 0;
  let typeScore = 0;
  let contextScore = 0;
  let attributeBonus = 0;
  let positionScore = 0;
  let visibilityScore = 0;

  const reasons: string[] = [];
  const matchedKeywords = new Set<string>();

  // Normalize attributes
  const idN = norm(attrs.id);
  const nameN = norm(attrs.name);
  const placeholderN = norm(attrs.placeholder);
  const labelN = norm(attrs.labelText);
  const ariaLabelN = norm(attrs.ariaLabel);
  const ariaDescribedbyN = norm(attrs.ariaDescribedby);
  const elemTextN = norm(attrs.elementText);
  const titleN = norm(attrs.title);
  const classN = norm(attrs.classNames);
  const dataTestIdN = norm(attrs.dataTestId);
  const autocompleteN = norm(attrs.autocomplete);

  const helpTextN = norm(attrs.helpText || '');
  const errorTextN = norm(attrs.errorText || '');
  const nearbyTextsN = (attrs.nearbyText || []).map(t => norm(t));

  const fullSearchText = [
    idN, nameN, placeholderN, labelN, ariaLabelN, ariaDescribedbyN,
    elemTextN, titleN, classN, dataTestIdN, autocompleteN, helpTextN,
    errorTextN, ...nearbyTextsN
  ].join(' ');

  // 4. Keyword matching with semantic dictionary & typo tolerance
  for (const word of translatedWords) {
    const mapping = SEMANTIC_DICTIONARY[word] || Object.values(SEMANTIC_DICTIONARY).find(m => m.primary.includes(word));

    if (mapping) {
      // Primary keyword match
      let isPrimaryMatched = false;
      for (const prim of mapping.primary) {
        const primN = norm(prim);
        if (fullSearchText.includes(primN) ||
            fuzzyMatch(primN, idN, 85) ||
            fuzzyMatch(primN, nameN, 85) ||
            fuzzyMatch(primN, placeholderN, 85) ||
            fuzzyMatch(primN, labelN, 85) ||
            fuzzyMatch(primN, ariaLabelN, 85)) {
          keywordScore += 50;
          matchedKeywords.add(word);
          isPrimaryMatched = true;
          reasons.push(`keyword:${word}`);
          break;
        }
      }

      // Synonym match
      if (!isPrimaryMatched) {
        for (const syn of mapping.synonyms) {
          const synN = norm(syn);
          if (fullSearchText.includes(synN) ||
              fuzzyMatch(synN, idN, 80) ||
              fuzzyMatch(synN, nameN, 80) ||
              fuzzyMatch(synN, placeholderN, 80) ||
              fuzzyMatch(synN, labelN, 80)) {
            keywordScore += 30;
            matchedKeywords.add(word);
            reasons.push(`synonym:${word}`);
            break;
          }
        }
      }

      // Context clues match
      for (const ctxClue of mapping.context) {
        const ctxClueN = norm(ctxClue);
        if (fullSearchText.includes(ctxClueN)) {
          contextScore += 15;
          reasons.push(`context:${ctxClue}`);
          break;
        }
      }

      // Type match
      const elType = attrs.type.toLowerCase();
      if (mapping.types.includes(elType)) {
        typeScore += 25;
        reasons.push(`type:${elType}`);
      }
    } else {
      // General fuzzy match fallback
      if (fuzzyMatch(word, idN, 85) ||
          fuzzyMatch(word, nameN, 85) ||
          fuzzyMatch(word, placeholderN, 85) ||
          fuzzyMatch(word, labelN, 85) ||
          fuzzyMatch(word, ariaLabelN, 85)) {
        keywordScore += 40;
        reasons.push(`fuzzy:${word}`);
      }
    }
  }

  // 5. Attribute bonuses (Aria-label, Label, Placeholder)
  const normTarget = norm(target);
  if (ariaLabelN && (ariaLabelN === normTarget || fuzzyMatch(ariaLabelN, normTarget, 90))) {
    attributeBonus += 35;
    reasons.push('aria-label:exact');
  } else if (ariaLabelN.includes(normTarget)) {
    attributeBonus += 25;
    reasons.push('aria-label:contains');
  }

  if (labelN && (labelN === normTarget || fuzzyMatch(labelN, normTarget, 90))) {
    attributeBonus += 30;
    reasons.push('label:exact');
  } else if (labelN.includes(normTarget)) {
    attributeBonus += 20;
    reasons.push('label:contains');
  }

  if (placeholderN && (placeholderN === normTarget || fuzzyMatch(placeholderN, normTarget, 90))) {
    attributeBonus += 25;
    reasons.push('placeholder:exact');
  } else if (placeholderN.includes(normTarget)) {
    attributeBonus += 15;
    reasons.push('placeholder:contains');
  }

  // Help / error text bonuses
  if (helpTextN && words.some(w => helpTextN.includes(norm(w)))) {
    attributeBonus += 10;
    reasons.push('help-text:match');
  }
  if (errorTextN && words.some(w => errorTextN.includes(norm(w)))) {
    attributeBonus += 10;
    reasons.push('error-text:match');
  }

  // 6. Position score
  if (attrs.position !== undefined && attrs.totalFieldsInForm !== undefined && attrs.totalFieldsInForm > 0) {
    const positionRatio = 1 - (attrs.position / attrs.totalFieldsInForm);
    positionScore = Math.round(10 * positionRatio);
    if (positionScore > 0) {
      reasons.push(`position:${attrs.position}`);
    }
  }

  // 7. Visibility score
  const isVisible = attrs.isVisible !== false;
  if (isVisible) {
    visibilityScore = 20;
    reasons.push('visible');
  }

  // 8. Dice bigram fallback (for very low-scoring candidates)
  let fallbackScore = 0;
  if (keywordScore === 0 && attributeBonus === 0) {
    const sim = Math.max(
      stringSimilarity(idN, normTarget),
      stringSimilarity(nameN, normTarget),
      stringSimilarity(placeholderN, normTarget),
      stringSimilarity(ariaLabelN, normTarget),
      stringSimilarity(labelN, normTarget),
      stringSimilarity(elemTextN, normTarget),
    );
    if (sim > 0.4) {
      fallbackScore = Math.round(sim * 40);
      reasons.push(`similarity:${Math.round(sim * 100)}%`);
    }
  }

  // Combine scores
  let totalScore = 0;
  if (keywordScore > 0 || attributeBonus > 0 || typeScore > 0 || fallbackScore > 0) {
    totalScore = keywordScore + typeScore + contextScore + attributeBonus + positionScore + visibilityScore + fallbackScore;
  }
  const score = Math.min(100, Math.max(0, Math.round(totalScore)));

  // Determine winning signal
  const winningSignal = reasons.join(' + ') || 'none';

  return { score, winningSignal };
}
