// netlify/functions/detect-surface.js
const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function parseDataUrl(dataUrl){
  const match = /^data:(.+);base64,(.+)$/.exec(dataUrl || '');
  if(!match) throw new Error('Format de data URL invalide.');
  return { mimeType: match[1], base64: match[2] };
}

function extractBoxesFromText(text){
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  let parsed;
  try{ parsed = JSON.parse(cleaned); } catch(e){ throw new Error('Réponse du modèle non-JSON : ' + cleaned.slice(0,200)); }
  const rawBoxes = Array.isArray(parsed) ? parsed : parsed.boxes;
  if(!Array.isArray(rawBoxes)) throw new Error('Le JSON ne contient pas de tableau "boxes".');
  
  return rawBoxes
    .map(b => {
      let x = Number(b.x);
      let y = Number(b.y);
      let w = Number(b.w);
      let h = Number(b.h);

      // SÉCURITÉ : Si Gemini renvoie des entiers entre 0 et 1000 (sa spécialité absolue),
      // on les divise par 1000 pour redonner des pourcentages propres au frontend (0 à 1)
      if (x > 1 || y > 1 || w > 1 || h > 1) {
        x = x / 1000;
        y = y / 1000;
        w = w / 1000;
        h = h / 1000;
      }
      return { x, y, w, h };
    })
    .filter(b =>
      [b.x, b.y, b.w, b.h].every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
      b.w > 0.01 && b.h > 0.01
    );
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if(event.httpMethod === 'OPTIONS'){
    return { statusCode: 204, headers: cors, body: '' };
  }
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Méthode non autorisée.' }) };
  }

  try{
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if(!GEMINI_API_KEY){
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'GEMINI_API_KEY non configurée.' }) };
    }

    const { photo } = JSON.parse(event.body || '{}');
    if(!photo){
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Champ "photo" requis.' }) };
    }
    const clientPhoto = parseDataUrl(photo);

    // PROMPT RENFORCÉ : ancrage strict sur des preuves visuelles + double passe d'auto-vérification
    // pour réduire les hallucinations (boîtes fantômes sur murs/ombres/électroménagers).
    const prompt = [
      "Tu es un système de vision par ordinateur de haute précision spécialisé dans le détourage de façades de meubles (portes et tiroirs).",
      "",
      "RÈGLE D'OR : tu ne dessines une boîte QUE si tu peux pointer un bord physique réel et continu dans l'image (un joint entre deux façades, une poignée, une charnière, un cadre). Si tu hésites entre 'il y a peut-être un meuble ici' et 'je ne vois pas de bord net', tu NE crées PAS la boîte. Le silence (aucune boîte) est toujours préférable à une boîte inventée.",
      "",
      "INTERDIT : déduire une boîte par symétrie, par répétition de motif, ou par logique d'ameublement ('il devrait y avoir une porte ici car la colonne d'à côté en a une'). Chaque boîte est justifiée uniquement par ce qui est visible dans CETTE image précise, jamais par une supposition générale sur les cuisines.",
      "",
      "ÉTAPE 1 — BALAYAGE (silencieux) : parcours l'image de GAUCHE À DROITE, colonne par colonne, jusqu'au bord droit inclus. Note chaque porte/tiroir dont tu vois clairement les 4 bords ou dont les bords sont coupés par le cadre de la photo. Une colonne étroite (bandeau, colonne de finition) collée à un mur ou à un électroménager compte comme une colonne à part entière.",
      "",
      "ÉTAPE 2 — DÉTOURAGE : une boîte distincte par porte/tiroir individuel, jamais un rectangle englobant plusieurs façades. Aligne chaque bord au pixel près sur le joint réel — s'arrêter avant le joint ou déborder dessus sont deux erreurs équivalentes. Pour les façades étroites (bandeaux, colonnes de finition), vérifie pixel par pixel chaque bord vertical : une erreur de quelques unités y est visible à l'écran alors qu'elle ne l'est pas sur une grande boîte.",
      "",
      "PIÈGES À NE PAS MANQUER (mais toujours sous réserve de la RÈGLE D'OR ci-dessus) : (1) une façade fine collée à un four/micro-ondes/frigo reste un meuble à détecter si son bord est visible ; (2) le dernier quart droit et le premier quart gauche de l'image sont les zones les plus souvent oubliées ou, à l'inverse, les plus souvent hallucinées en zone de bordure — vérifie chaque bord avec la même exigence que pour le centre de l'image ; (3) couvre les éléments partiellement coupés par le cadre uniquement si leur bord de joint est réellement visible sur la portion capturée.",
      "",
      "EXCLUSIONS STRICTES (jamais de boîte dessus) : plan de travail, crédence, évier, robinet, murs, sol, plafond, la grande niche ouverte centrale en bois, reflets, ombres portées, et TOUS les électroménagers eux-mêmes (four, micro-ondes, plaque, hotte, frigo, lave-vaisselle...).",
      "",
      "ÉTAPE 3 — AUTO-VÉRIFICATION (obligatoire, silencieuse, avant de répondre) : reprends ta liste boîte par boîte. Pour chacune, demande-toi 'quel bord précis (joint, poignée, charnière) prouve que cette boîte existe ?'. Si tu ne peux pas répondre par un élément visuel concret et localisé, supprime la boîte immédiatement. Ne renvoie que les boîtes qui survivent à cette vérification.",
      "",
      "SYSTÈME DE COORDONNÉES (Échelle 0 à 1000, entiers uniquement) :",
      "Image = 1000×1000 unités. x/y = coin haut-gauche (0=bord gauche/haut, 1000=bord droit/bas). w/h = largeur/hauteur du rectangle."
    ].join('\n');

    const body = {
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: clientPhoto.mimeType, data: clientPhoto.base64 } }
          ]
        }
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        thinkingConfig: {
          thinkingLevel: 'MEDIUM' // précision privilégiée sur la vitesse : moins de zones fantômes/oubliées
        },
        maxOutputTokens: 30000,
        responseSchema: {
          type: "OBJECT",
          properties: {
            boxes: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  x: { type: "INTEGER" },
                  y: { type: "INTEGER" },
                  w: { type: "INTEGER" },
                  h: { type: "INTEGER" }
                },
                required: ["x", "y", "w", "h"]
              }
            }
          },
          required: ["boxes"]
        }
      }
    };

    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(body)
    });

    if(!geminiRes.ok){
      const errText = await geminiRes.text().catch(()=> '');
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "L'API Gemini a renvoyé une erreur.", details: errText }) };
    }

    const data = await geminiRes.json();
    const finishReason = data?.candidates?.[0]?.finishReason;
    if(finishReason === 'MAX_TOKENS'){
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "La réponse a été coupée avant la fin (budget de tokens dépassé). Augmente maxOutputTokens." }) };
    }
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
    if(!text){
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Pas de résultat exploitable." }) };
    }

    let boxes;
    try{
      boxes = extractBoxesFromText(text);
    } catch(parseErr){
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Réponse illisible.', details: parseErr.message }) };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ boxes }) };

  } catch(err){
    console.error('Erreur detect-surface:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Erreur interne du serveur.' }) };
  }
};
