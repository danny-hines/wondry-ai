// Keyless mock artifact generator. Produces genuinely interactive, self-contained,
// CSP-safe HTML lessons so the app is fully demonstrable without an API key.
// The REAL generator (Claude) uses the same render contract — see systemPrompt.js.
import { pickEmoji, titleCase, extractTopic } from './providers.js';

// Small themed content library; everything else uses a strong generic template.
const LIBRARY = {
  rock: {
    color: '#b45309',
    emoji: '🪨',
    title: 'The Rock Cycle',
    intro:
      "Rocks are always changing — it just happens SO slowly we can't see it! Let's follow a rock on its big adventure.",
    cards: [
      ['Igneous', '🌋', 'Born from hot, melted rock called magma. When it cools, it turns solid!'],
      [
        'Sedimentary',
        '🏖️',
        'Made from tiny bits of sand and shells squished together over a long, long time.',
      ],
      [
        'Metamorphic',
        '💎',
        'Changed by heat and squeezing deep underground into something brand new.',
      ],
    ],
    facts: [
      'A rock can take MILLIONS of years to change.',
      'Diamonds are rocks made deep inside the Earth!',
      'Some beaches are made of crushed-up rock and shells.',
    ],
    quiz: {
      q: 'Which rock is born from a volcano?',
      a: ['Igneous', 'Sedimentary', 'Metamorphic'],
      correct: 0,
    },
  },
  space: {
    color: '#4338ca',
    emoji: '🚀',
    title: 'A Trip Through Space',
    intro: "Put on your space helmet! We're blasting off to explore the planets and stars.",
    cards: [
      ['The Sun', '☀️', 'A giant ball of burning gas. It keeps us warm from far, far away!'],
      [
        'The Moon',
        '🌙',
        "Earth's rocky neighbor. It has no air, and astronauts have walked on it!",
      ],
      ['The Stars', '⭐', 'Other suns, so far away they look like tiny sparkles at night.'],
    ],
    facts: [
      'The Sun is so big that one million Earths could fit inside!',
      'It takes 8 minutes for sunlight to reach us.',
      'There is no sound in space.',
    ],
    quiz: { q: 'What is the Moon made of?', a: ['Cheese', 'Rock', 'Water'], correct: 1 },
  },
  count: {
    color: '#0d9488',
    emoji: '🔢',
    title: "Let's Count Together!",
    intro: 'Counting is everywhere! Tap the apples and count out loud with me.',
    cards: [
      ['Count to 5', '🍎', 'One, two, three, four, five! High five!'],
      ['Count by 2s', '👟', 'Two, four, six, eight — like counting shoes in pairs!'],
      ['Big numbers', '💯', 'After ten comes eleven, twelve... all the way to one hundred!'],
    ],
    facts: [
      'Zero means "nothing at all".',
      'You have ten fingers — perfect for counting!',
      'A dozen means twelve.',
    ],
    quiz: { q: 'What comes after the number 4?', a: ['6', '5', '2'], correct: 1 },
  },
  pig: {
    color: '#db2777',
    emoji: '🐷',
    title: 'The Three Little Pigs',
    intro: 'Once upon a time, three little pigs left home to build houses of their very own.',
    cards: [
      [
        'House of Straw',
        '🌾',
        'The first pig built fast with straw. But the wolf huffed and puffed it down!',
      ],
      ['House of Sticks', '🪵', 'The second pig used sticks. The wolf blew that one over too!'],
      [
        'House of Bricks',
        '🧱',
        'The third pig worked hard with bricks. The wolf could NOT blow it down!',
      ],
    ],
    facts: [
      'Working hard pays off — just like the brick house!',
      'Bricks are made from baked clay.',
      'The story teaches us to be prepared.',
    ],
    quiz: {
      q: 'Which house did the wolf fail to blow down?',
      a: ['Straw', 'Sticks', 'Bricks'],
      correct: 2,
    },
  },
  ocean: {
    color: '#0284c7',
    emoji: '🌊',
    title: 'Under the Ocean',
    intro: "Let's dive deep into the big blue ocean and meet the creatures who live there!",
    cards: [
      ['Fish', '🐟', 'Fish breathe underwater using gills instead of lungs.'],
      ['Whales', '🐋', 'The blue whale is the biggest animal that has EVER lived!'],
      ['Coral', '🪸', 'Coral looks like a plant but is actually made of tiny animals.'],
    ],
    facts: [
      'The ocean covers most of our planet.',
      'Octopuses have three hearts!',
      'Some parts of the ocean are deeper than mountains are tall.',
    ],
    quiz: { q: 'How do fish breathe underwater?', a: ['Gills', 'Lungs', 'Nose'], correct: 0 },
  },
};

function genericContent(topic) {
  const t = titleCase(topic);
  return {
    color: '#8b5cf6',
    emoji: pickEmoji(topic),
    title: t,
    intro: `Let's discover some amazing things about ${topic}! Tap the cards to learn more.`,
    cards: [
      ['What is it?', '🔍', `${t} is something really interesting to explore and understand.`],
      ['Why it matters', '💡', `Learning about ${topic} helps us understand the world around us.`],
      ['Cool part', '✨', `There are so many surprising things to discover about ${topic}!`],
    ],
    facts: [
      `${t} is full of surprises.`,
      'Asking questions is how we learn!',
      'You can always explore more.',
    ],
    quiz: {
      q: `Is learning about ${topic} fun?`,
      a: ['Yes!', 'Yes, a lot!', 'Absolutely!'],
      correct: 0,
    },
  };
}

function contentFor(topic) {
  const s = topic.toLowerCase();
  for (const k of Object.keys(LIBRARY)) if (s.includes(k)) return LIBRARY[k];
  if (s.includes('volcano')) return LIBRARY.rock;
  if (s.includes('moon') || s.includes('star') || s.includes('planet')) return LIBRARY.space;
  if (s.includes('number') || s.includes('math')) return LIBRARY.count;
  if (s.includes('fish') || s.includes('sea') || s.includes('whale')) return LIBRARY.ocean;
  return genericContent(topic);
}

export function mockArtifactHTML(rawTopic, profile) {
  const topic = extractTopic(rawTopic);
  const c = contentFor(topic);
  const name = profile?.name || 'friend';
  const html = renderLesson(c, name);
  return { html, title: c.title, emoji: c.emoji, color: c.color, plan: c.intro.slice(0, 80) };
}

// Keyless reading-practice lesson (mirrors runReading's validated shape) so the
// read-along + grading loop is fully demonstrable offline. Difficulty bands track
// the requested level; lines stay single, decodable sentences.
export function mockReadingLesson({ profile, interests, level = 2 }) {
  const name = profile?.name || 'friend';
  const theme = (interests || '').split(/[,/]/)[0].trim() || 'a brave little fox';
  const band = level <= 2 ? 'easy' : level === 3 ? 'mid' : 'hard';
  const P = {
    easy: [
      ['🌟', [`Hi ${name}.`, `We can read.`]],
      ['🔎', [`Look at ${theme}.`, `It is so fun.`]],
      ['🏃', [`We run and play.`, `It is a good day.`]],
      ['🎉', [`Good job ${name}.`, `You can read!`]],
    ],
    mid: [
      ['🌟', [`Hello ${name}, let us read together today.`]],
      ['🔎', [`Our story is all about ${theme}.`, `There is so much to discover.`]],
      ['🏃', [`We run and jump and laugh along the way.`]],
      ['🎉', [`Great reading, ${name}, you really did it!`]],
    ],
    hard: [
      ['🌟', [`Hello ${name}, settle in for a wonderful little adventure today.`]],
      ['🔎', [`Our story explores the amazing and surprising world of ${theme}.`]],
      ['🏃', [`Together we race ahead, curious about every twist and turn.`]],
      ['🎉', [`Fantastic reading, ${name}, you should be very proud of yourself!`]],
    ],
  };
  const pages = P[band].map(([illustration, lines]) => ({ illustration, lines }));
  return {
    title: `${titleCase(theme).slice(0, 36)} Story`,
    emoji: pickEmoji(theme),
    interest: theme,
    level,
    pages,
  };
}

// Keyless mock flashcard set (declarative doc) so the widget kit is demoable
// offline. Builds a small themed deck + a quiz from the topic.
export function mockFlashcardsDoc({ topic }) {
  const t = (topic || 'animals').trim() || 'animals';
  const T = titleCase(t);
  const cards = [
    {
      front: `What is ${t}?`,
      back: `${T} is something fun and interesting to learn about!`,
      hint: 'Think about what you already know.',
    },
    {
      front: `A cool fact about ${t}`,
      back: `There are lots of surprising things to discover about ${t}.`,
    },
    { front: `Why ${t} matters`, back: `Learning about ${t} helps us understand the world.` },
    { front: `${T} word`, back: `Say "${t}" out loud — nice job!` },
    { front: `Explore ${t}`, back: `Ask a grown-up to help you find more about ${t}.` },
    { front: `Remember ${t}`, back: `You can always come back and practice ${t} again!` },
  ];
  return {
    title: `${T} Flashcards`,
    emoji: pickEmoji(t),
    subject: t,
    blocks: [
      { type: 'text', text: `Let's study ${t} with some flashcards! Tap a card to flip it.` },
      { type: 'flashcards', cards },
      {
        type: 'quiz',
        question: `Is learning about ${t} fun?`,
        options: ['Yes!', 'Yes, a lot!', 'Absolutely!'],
        answer: 0,
      },
    ],
  };
}

// Keyless mock explorable scenes (declarative docs centered on a 'scene' block) so
// the widget is demoable offline. A few hand-built scenes + a generic fallback.
const SCENES = {
  solar: {
    title: 'Our Solar System',
    emoji: '🪐',
    subject: 'the solar system',
    intro: 'Welcome to space! Tap the sun or any planet to zoom in and hear all about it.',
    scene: {
      layout: 'orbit',
      center: {
        label: 'The Sun',
        emoji: '☀️',
        blurb: 'The sun is a giant ball of hot, glowing gas at the center of everything.',
        facts: [
          'The sun is so big that a million Earths could fit inside it.',
          'Its warmth and light reach us from very far away.',
        ],
      },
      nodes: [
        {
          label: 'Mercury',
          emoji: '🌑',
          size: 0.7,
          blurb: 'Mercury is the closest planet to the sun and the smallest one.',
          facts: [
            'It zips around the sun faster than any other planet.',
            'Days are blazing hot and nights are freezing cold.',
          ],
        },
        {
          label: 'Venus',
          emoji: '🌕',
          size: 0.9,
          blurb: 'Venus is wrapped in thick clouds and is the hottest planet.',
          facts: [
            'It shines brightly and is sometimes called the evening star.',
            'Its clouds trap heat like a cozy blanket.',
          ],
        },
        {
          label: 'Earth',
          emoji: '🌍',
          size: 1,
          blurb: 'Earth is our home, the blue planet covered in water and life.',
          facts: [
            'It is the only planet we know of with living things.',
            'Most of Earth is covered by big blue oceans.',
          ],
        },
        {
          label: 'Mars',
          emoji: '🔴',
          size: 0.8,
          blurb: 'Mars is the dusty red planet that explorers love to study.',
          facts: [
            'Its red color comes from rusty iron in the soil.',
            'Robots called rovers drive around exploring it.',
          ],
        },
        {
          label: 'Jupiter',
          emoji: '🪐',
          size: 1.6,
          blurb: 'Jupiter is the biggest planet of all, a giant ball of swirling gas.',
          facts: [
            'It has a huge storm bigger than our whole planet.',
            'Many little moons circle around it.',
          ],
        },
        {
          label: 'Saturn',
          emoji: '💫',
          size: 1.4,
          blurb: 'Saturn is famous for its beautiful, sparkly rings.',
          facts: [
            'Its rings are made of ice and rock.',
            'It is so light it could float in a giant bathtub.',
          ],
        },
      ],
    },
    quiz: { q: 'Which planet is our home?', a: ['Mars', 'Earth', 'Jupiter'], correct: 1 },
  },
  body: {
    title: 'The Human Body',
    emoji: '🧍',
    subject: 'the human body',
    intro: 'Your body is amazing! Tap each part to find out the special job it does.',
    scene: {
      layout: 'map',
      backdrop: 'body',
      nodes: [
        {
          label: 'Brain',
          emoji: '🧠',
          x: 50,
          y: 9,
          blurb: 'Your brain is the boss that helps you think, feel, and remember.',
          facts: [
            'It tells the rest of your body what to do.',
            'It never stops working, even while you sleep.',
          ],
        },
        {
          label: 'Heart',
          emoji: '🫀',
          x: 44,
          y: 34,
          blurb: 'Your heart pumps blood all around your body, day and night.',
          facts: [
            'It beats faster when you run and play.',
            'It is about the size of your own fist.',
          ],
          icon: {
            viewBox: '0 0 24 24',
            shapes: [
              {
                type: 'path',
                d: 'M12 21 C12 21 4 13.8 4 8.8 C4 6.4 5.9 4.5 8.3 4.5 C9.8 4.5 11.2 5.4 12 6.8 C12.8 5.4 14.2 4.5 15.7 4.5 C18.1 4.5 20 6.4 20 8.8 C20 13.8 12 21 12 21 Z',
                fill: 'currentColor',
              },
            ],
          },
        },
        {
          label: 'Lungs',
          emoji: '🫁',
          x: 58,
          y: 34,
          blurb: 'Your lungs fill with air so you can breathe in and out.',
          facts: [
            'You have two lungs, one on each side.',
            'They help you blow out birthday candles.',
          ],
        },
        {
          label: 'Tummy',
          emoji: '🍎',
          x: 50,
          y: 52,
          blurb: 'Your tummy turns the food you eat into energy to grow and play.',
          facts: [
            'It gets to work right after you swallow.',
            'Good food keeps it happy and strong.',
          ],
        },
        {
          label: 'Hands',
          emoji: '✋',
          x: 18,
          y: 56,
          blurb: 'Your hands let you hold, build, wave, and high five.',
          facts: [
            'Each hand has five clever fingers.',
            'Your thumbs help you grab things tightly.',
          ],
        },
        {
          label: 'Feet',
          emoji: '🦶',
          x: 58,
          y: 94,
          blurb: 'Your feet hold you up so you can walk, run, and jump.',
          facts: ['They balance your whole body.', 'Wiggling your toes helps you stay steady.'],
        },
      ],
    },
    quiz: {
      q: 'Which part pumps blood around your body?',
      a: ['Brain', 'Heart', 'Feet'],
      correct: 1,
    },
  },
  water: {
    title: 'The Water Cycle',
    emoji: '💧',
    subject: 'the water cycle',
    intro: 'Water goes on a never-ending journey! Tap each step to follow the loop.',
    scene: {
      layout: 'cycle',
      nodes: [
        {
          label: 'Evaporation',
          emoji: '☀️',
          blurb: 'The warm sun turns water into invisible vapor that floats up into the sky.',
          facts: [
            'Water rises up from oceans, lakes, and puddles.',
            'You cannot see vapor, but it is there.',
          ],
        },
        {
          label: 'Condensation',
          emoji: '☁️',
          blurb: 'High up, the vapor cools and gathers together to make fluffy clouds.',
          facts: [
            'Tiny drops join up to build a cloud.',
            'Clouds are made of billions of water droplets.',
          ],
        },
        {
          label: 'Precipitation',
          emoji: '🌧️',
          blurb: 'When clouds get heavy, water falls back down as rain or snow.',
          facts: [
            'Rain, snow, and hail are all precipitation.',
            'This is the water coming back to the ground.',
          ],
        },
        {
          label: 'Collection',
          emoji: '🌊',
          blurb: 'The water gathers in rivers, lakes, and oceans, ready to start again.',
          facts: [
            'Rivers carry water back to the sea.',
            'Then the sun warms it and the loop begins anew.',
          ],
        },
      ],
    },
    quiz: {
      q: 'What makes water rise into the sky?',
      a: ['The moon', 'The warm sun', 'The wind'],
      correct: 1,
    },
  },
};
function genericScene(topic) {
  const t = titleCase(topic);
  return {
    title: t,
    emoji: pickEmoji(topic),
    subject: topic,
    intro: `Let's explore ${topic}! Tap each part to zoom in and hear about it.`,
    scene: {
      layout: 'map',
      nodes: [
        {
          label: 'Part one',
          emoji: '🔵',
          x: 25,
          y: 30,
          blurb: `This is one interesting part of ${topic}.`,
          facts: [`There is a lot to discover about ${topic}.`],
        },
        {
          label: 'Part two',
          emoji: '🟢',
          x: 70,
          y: 30,
          blurb: `Here is another part of ${topic} to explore.`,
          facts: ['Tap around to learn more!'],
        },
        {
          label: 'Part three',
          emoji: '🟡',
          x: 30,
          y: 72,
          blurb: `${t} has so many pieces that fit together.`,
          facts: ['Every part has its own special job.'],
        },
        {
          label: 'Part four',
          emoji: '🟣',
          x: 72,
          y: 72,
          blurb: `Exploring ${topic} helps us understand the world.`,
          facts: ['Asking questions is how we learn!'],
        },
      ],
    },
    quiz: {
      q: `Is exploring ${topic} fun?`,
      a: ['Yes!', 'Yes, a lot!', 'Absolutely!'],
      correct: 0,
    },
  };
}
export function mockExplorableDoc({ topic }) {
  const t = (topic || 'the solar system').trim() || 'the solar system';
  const s = t.toLowerCase();
  let c;
  if (/(solar system|planet|space|orbit|sun)/.test(s)) c = SCENES.solar;
  else if (/(body|anatomy|organ|skeleton)/.test(s)) c = SCENES.body;
  else if (/(water cycle|rain|evaporat)/.test(s)) c = SCENES.water;
  else c = genericScene(t);
  return {
    title: c.title,
    emoji: c.emoji,
    subject: c.subject,
    blocks: [
      { type: 'text', text: c.intro },
      { type: 'scene', ...c.scene },
      { type: 'quiz', question: c.quiz.q, options: c.quiz.a, answer: c.quiz.correct },
    ],
  };
}

// Keyless mock for the memory matching game: a themed set of 6 emoji+label pairs.
const MEMORY_SETS = {
  animals: [
    ['🐶', 'Dog'],
    ['🐱', 'Cat'],
    ['🦁', 'Lion'],
    ['🐯', 'Tiger'],
    ['🐰', 'Rabbit'],
    ['🐸', 'Frog'],
    ['🐼', 'Panda'],
    ['🦊', 'Fox'],
  ],
  space: [
    ['🚀', 'Rocket'],
    ['🌙', 'Moon'],
    ['⭐', 'Star'],
    ['🪐', 'Planet'],
    ['☄️', 'Comet'],
    ['🛸', 'UFO'],
    ['👽', 'Alien'],
    ['🌍', 'Earth'],
  ],
  food: [
    ['🍎', 'Apple'],
    ['🍌', 'Banana'],
    ['🍕', 'Pizza'],
    ['🍓', 'Strawberry'],
    ['🥕', 'Carrot'],
    ['🍪', 'Cookie'],
    ['🧀', 'Cheese'],
    ['🍩', 'Donut'],
  ],
  ocean: [
    ['🐟', 'Fish'],
    ['🐙', 'Octopus'],
    ['🐢', 'Turtle'],
    ['🦀', 'Crab'],
    ['🐳', 'Whale'],
    ['🐬', 'Dolphin'],
    ['🦈', 'Shark'],
    ['🐚', 'Shell'],
  ],
  vehicles: [
    ['🚗', 'Car'],
    ['🚌', 'Bus'],
    ['✈️', 'Plane'],
    ['🚂', 'Train'],
    ['🚲', 'Bike'],
    ['🚁', 'Helicopter'],
    ['🚢', 'Ship'],
    ['🚒', 'Fire Truck'],
  ],
};
export function mockMemoryGame({ theme }) {
  const t = (theme || 'animals').trim() || 'animals';
  const key = Object.keys(MEMORY_SETS).find((k) => t.toLowerCase().includes(k)) || 'animals';
  const set = MEMORY_SETS[key].slice(0, 6).map(([emoji, label]) => ({ emoji, label }));
  return { title: `${titleCase(t)} Memory`, emoji: set[0].emoji, theme: t, pairs: set };
}

// The shared render contract: self-contained, inline only, tap-to-hear via
// postMessage to the kiosk shell, "finished" signal for engagement tracking.
function renderLesson(c, name) {
  const cards = c.cards
    .map(
      ([t, e, d], i) => `
    <button class="card" data-i="${i}" style="animation-delay:${i * 0.08}s">
      <span class="ce">${e}</span>
      <span class="ct">${t}</span>
      <span class="cd">${d}</span>
      <span class="hear">🔊 tap to hear</span>
    </button>`,
    )
    .join('');
  const facts = c.facts.map((f) => `<li>${f}</li>`).join('');
  const opts = c.quiz.a
    .map((a, i) => `<button class="opt" data-correct="${i === c.quiz.correct}">${a}</button>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${c.title}</title>
<style>
  :root { --c: ${c.color}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-rounded, "Comic Sans MS", system-ui, sans-serif; background:
    radial-gradient(circle at 30% 0%, color-mix(in srgb, var(--c) 18%, white), #fff 70%);
    color: #1f2430; padding: 28px; min-height: 100vh; }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 2.4rem; color: var(--c); display: flex; gap: 12px; align-items: center; }
  .intro { font-size: 1.25rem; line-height: 1.5; margin: 14px 0 26px; }
  .cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit,minmax(200px,1fr)); }
  .card { text-align: left; border: 3px solid color-mix(in srgb, var(--c) 30%, white);
    background: #fff; border-radius: 18px; padding: 18px; cursor: pointer; display: flex;
    flex-direction: column; gap: 6px; transition: transform .15s, box-shadow .15s;
    animation: pop .4s both; }
  .card:hover { transform: translateY(-4px); box-shadow: 0 10px 24px rgba(0,0,0,.12); }
  .ce { font-size: 2.6rem; }
  .ct { font-size: 1.3rem; font-weight: 800; color: var(--c); }
  .cd { font-size: 1.05rem; line-height: 1.45; }
  .hear { font-size: .8rem; color: #8a93a3; margin-top: 4px; }
  h2 { margin: 30px 0 10px; color: var(--c); }
  .facts li { font-size: 1.1rem; margin: 8px 0 8px 22px; }
  .quiz { margin-top: 28px; background: color-mix(in srgb, var(--c) 12%, white);
    border-radius: 18px; padding: 20px; }
  .opt { font: inherit; font-size: 1.1rem; font-weight: 700; margin: 6px 8px 6px 0;
    padding: 12px 20px; border-radius: 14px; border: none; cursor: pointer;
    background: #fff; box-shadow: 0 2px 6px rgba(0,0,0,.1); }
  .opt.right { background: #16a34a; color: #fff; }
  .opt.wrong { background: #ef4444; color: #fff; }
  .done { margin: 34px 0 10px; text-align: center; }
  .done button { font: inherit; font-size: 1.2rem; font-weight: 800; color: #fff;
    background: var(--c); border: none; border-radius: 16px; padding: 14px 30px; cursor: pointer; }
  @keyframes pop { from { opacity: 0; transform: scale(.9) } to { opacity: 1; transform: scale(1) } }
</style></head>
<body><div class="wrap">
  <h1><span>${c.emoji}</span> ${c.title}</h1>
  <p class="intro">Hi ${name}! ${c.intro}</p>
  <div class="cards">${cards}</div>
  <h2>✨ Fun Facts</h2>
  <ul class="facts">${facts}</ul>
  <div class="quiz">
    <h2 style="margin-top:0">🧠 Quick Quiz</h2>
    <p style="font-size:1.15rem;font-weight:700;margin-bottom:10px">${c.quiz.q}</p>
    <div>${opts}</div>
  </div>
  <div class="done"><button id="finish">I finished! 🎉</button></div>
</div>
<script>
  // tap-to-hear -> ask the kiosk shell to speak (it owns TTS / Piper)
  function speak(t){ parent.postMessage({ type:'speak', text:t }, '*'); }
  document.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => {
      const t = card.querySelector('.ct').textContent + '. ' + card.querySelector('.cd').textContent;
      speak(t);
    });
  });
  document.querySelectorAll('.opt').forEach(o => o.addEventListener('click', () => {
    const right = o.dataset.correct === 'true';
    o.classList.add(right ? 'right' : 'wrong');
    speak(right ? 'That is correct! Great job!' : 'Good try! Have another go.');
  }));
  document.getElementById('finish').addEventListener('click', () => {
    parent.postMessage({ type:'finished' }, '*');
    speak('Yay! You finished. I am so proud of you!');
  });
</script>
</body></html>`;
}
