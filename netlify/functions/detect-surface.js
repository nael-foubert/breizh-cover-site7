// netlify/functions/detect-surface.js
const GEMINI_MODEL = 'gemini-3.5-flash'; // Passage au modèle de production gratuit beaucoup plus précis
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
      if (!b.box_2d || b.box_2d.length !== 4) return null;
      
      // Gemini renvoie nativement [y_min, x_min, y_max, x_max] de 0 à 1000
      const [y_min, x_min, y_max, x_max] = b.box_2d;

      // Traduction et conversion immédiate en pourcentages (0 à 1) pour ton frontend
      const x = x_min / 1000;
      const y = y_min / 1000;
      const w = (x_max - x_min) / 1000;
      const h = (y_max - y_min) / 1000;

      return { x, y, w, h };
    })
    .filter(b =>
      b &&
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

    // Prompt optimisé pour le protocole de détection natif de Gemini
    const prompt = [
      "Tu es un système de vision par ordinateur de haute précision spécialisé dans le repérage de façades de meubles (portes et tiroirs).",
      "Détecte chaque porte et tiroir visible individuellement.",
      "Pour chaque élément détecté, renvoie ses coordonnées précises dans le tableau 'box_2d' au format [y_min, x_min, y_max, x_max].",
      "RÈGLE D'OR : Aligne chaque bord au pixel près sur le joint réel entre les façades. Ne déborde pas sur les poignées ou les appareils électroménagers.",
      "EXCLUSIONS STRICTES : Exclue les murs, sols, plans de travail, fours, micro-ondes, et réfrigérateurs."
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
        // ATTENTION : On supprime totalement 'thinkingConfig' ici car il fait bugger la détection spatiale.
        maxOutputTokens: 4096, 
        responseSchema: {
          type: "OBJECT",
          properties: {
            boxes: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  box_2d: {
                    type: "ARRAY",
                    description: "Coordonnées de l'objet au format natif [y_min, x_min, y_max, x_max], échelle 0 à 1000",
                    items: { type: "INTEGER" }
                  }
                },
                required: ["box_2d"]
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
