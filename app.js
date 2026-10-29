// Sonic Donation: narrated walkthrough of hearing, donating and hearing again.

const NARRATION_DIR = 'Narrations/';
const LIBRARY_DIR = 'SoundLibrary/';

const NARRATIONS = {
  intro: 'Narration v1.m4a',
  record: 'Narration v2.m4a',
  clear: 'Narration 3..m4a',
  choice: 'Narration v4.m4a',
  donate: 'Narration 4A2.m4a',
  delete: 'Narration 4B.m4a',
  end: 'Narration 6.m4a',
};

const CLIP_SECONDS = 10;          // library sounds are cut to this length
const GAP_SECONDS = 0.8;          // pause between steps
const MAX_RECORD_SECONDS = 60;    // safety cap if Stop is never pressed
const BLEND_USER_START = 2.5;     // seconds into the library sound before the user's sound fades in
const BLEND_USER_FADE_IN = 3;     // seconds for the user's sound to fade in
const DISSOLVE_SECONDS = 12;      // max length of the user's sound on the Delete path

let ctx;
let narrations = {};
let reverbImpulse;

// Session state shared between steps.
let library = null;
let recording = null;
let choice = 'donate';            // used if the choice step is skipped

// Step runner state. Each step's audio goes through its own output node,
// so skipping can silence it immediately.
let stepIndex = 0;
let stepController = null;
let stepOut = null;

// ---------- UI ----------

const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $('status').textContent = text;
}

function showPanel(id) {
  for (const panel of ['start-panel', 'record-panel', 'choice-panel', 'thanks-panel']) {
    $(panel).hidden = panel !== id;
  }
}

// ---------- Audio helpers ----------

// Resolves after `seconds`, or early if `signal` aborts.
function wait(seconds, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function loadBuffer(dir, name) {
  const res = await fetch(dir + encodeURIComponent(name));
  if (!res.ok) throw new Error(`Could not load ${dir}${name} (${res.status})`);
  return ctx.decodeAudioData(await res.arrayBuffer());
}

async function loadNarrations() {
  const entries = await Promise.all(
    Object.entries(NARRATIONS).map(async ([key, name]) => [key, await loadBuffer(NARRATION_DIR, name)])
  );
  narrations = Object.fromEntries(entries);
}

// Picks a random library sound, trying others if one fails to decode.
async function loadRandomLibrarySound() {
  const pool = [...window.SOUND_LIBRARY];
  while (pool.length) {
    const name = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    try {
      const buffer = await loadBuffer(LIBRARY_DIR, name);
      console.log('Library sound:', name, `(${buffer.duration.toFixed(1)}s)`);
      return buffer;
    } catch (err) {
      console.warn('Skipping', name, err);
    }
  }
  throw new Error('No playable sounds found in SoundLibrary.');
}

function clipLength(buffer) {
  return Math.min(buffer.duration, CLIP_SECONDS);
}

// Plays a buffer from `start` for `duration` seconds into `destination`.
function playSource(buffer, destination, start, duration) {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(destination);
  source.start(start, 0, duration);
  return source;
}

// Gain node that fades in at `start` and out at `end` to avoid clicks.
function envelope(start, end, peak = 1, fade = 0.05) {
  fade = Math.min(fade, (end - start) / 2);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + fade);
  gain.gain.setValueAtTime(peak, end - fade);
  gain.gain.linearRampToValueAtTime(0, end);
  return gain;
}

// Synthetic room reverb: decaying stereo noise.
function makeReverbImpulse(seconds = 3.5, decay = 2.5) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

function makeReverb() {
  const convolver = ctx.createConvolver();
  convolver.buffer = reverbImpulse;
  return convolver;
}

// Looping vinyl-style crackle: faint hiss plus sparse pops.
function makeCrackleBuffer(seconds = 3) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] += (Math.random() * 2 - 1) * 0.015;
    if (Math.random() < 0.0006) {
      const amp = (Math.random() * 2 - 1) * (0.3 + Math.random() * 0.7);
      for (let j = 0; j < 40 && i + j < length; j++) {
        data[i + j] += amp * Math.exp(-j / 6) * (Math.random() * 2 - 1);
      }
    }
  }
  return buffer;
}

function softClipCurve(amount = 25) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}

// ---------- Sounds ----------

async function playNarration(key, signal) {
  const buffer = narrations[key];
  const start = ctx.currentTime + 0.05;
  playSource(buffer, stepOut, start, buffer.duration);
  await wait(buffer.duration + 0.05, signal);
}

// Library sound made crackly and far away: band-limited, overdriven,
// drowned in reverb, with crackle laid on top.
async function playDistorted(buffer, signal) {
  const duration = clipLength(buffer);
  const tail = 2.5;
  const start = ctx.currentTime + 0.05;
  const end = start + duration;

  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(stepOut);

  const highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 350 });
  const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1600, Q: 0.7 });
  const drive = new GainNode(ctx, { gain: 3 });
  const shaper = new WaveShaperNode(ctx, { curve: softClipCurve(), oversample: '4x' });
  const dry = new GainNode(ctx, { gain: 0.25 });
  const wet = new GainNode(ctx, { gain: 0.6 });
  const reverb = makeReverb();
  const env = envelope(start, end, 0.6, 0.5);

  env.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(drive);
  drive.connect(shaper);
  shaper.connect(dry);
  shaper.connect(reverb);
  reverb.connect(wet);
  dry.connect(master);
  wet.connect(master);
  playSource(buffer, env, start, duration);

  const crackle = ctx.createBufferSource();
  crackle.buffer = makeCrackleBuffer();
  crackle.loop = true;
  const crackleFilter = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 800 });
  const crackleGain = envelope(start, end + tail, 0.5, 0.5);
  crackle.connect(crackleFilter);
  crackleFilter.connect(crackleGain);
  crackleGain.connect(master);
  crackle.start(start);
  crackle.stop(end + tail);

  await wait(duration + tail, signal);
}

async function playClear(buffer, signal) {
  const duration = clipLength(buffer);
  const start = ctx.currentTime + 0.05;
  const env = envelope(start, start + duration, 1, 0.3);
  env.connect(stepOut);
  playSource(buffer, env, start, duration);
  await wait(duration + 0.1, signal);
}

// Library sound starts alone; the user's sound fades in over it, then both fade out together.
async function playBlend(library, recording, signal) {
  const libDuration = clipLength(library);
  const userStart = Math.min(BLEND_USER_START, libDuration * 0.3);
  const userDuration = Math.min(recording.duration, CLIP_SECONDS + 5);
  const total = Math.max(libDuration, userStart + userDuration);
  const start = ctx.currentTime + 0.05;
  const end = start + total;

  const master = envelope(start, end, 1, 1.5);
  master.connect(stepOut);

  const libGain = envelope(start, start + libDuration, 0.8, 0.3);
  libGain.connect(master);
  playSource(library, libGain, start, libDuration);

  const userGain = ctx.createGain();
  userGain.gain.setValueAtTime(0, start + userStart);
  userGain.gain.linearRampToValueAtTime(1, start + userStart + BLEND_USER_FADE_IN);
  userGain.connect(master);
  playSource(recording, userGain, start + userStart, userDuration);

  await wait(total + 0.1, signal);
}

// User's sound loses its detail, sinks into reverb and fades to silence.
async function playDissolve(recording, signal) {
  const duration = Math.min(recording.duration, DISSOLVE_SECONDS);
  const tail = 3;
  const start = ctx.currentTime + 0.05;
  const end = start + duration;

  const master = ctx.createGain();
  master.gain.setValueAtTime(0, start);
  master.gain.linearRampToValueAtTime(1, start + 0.1);
  master.gain.linearRampToValueAtTime(0.6, start + duration * 0.5);
  master.gain.linearRampToValueAtTime(0, end + tail);
  master.connect(stepOut);

  const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 12000 });
  lowpass.frequency.setValueAtTime(12000, start);
  lowpass.frequency.exponentialRampToValueAtTime(250, end);

  const dry = ctx.createGain();
  dry.gain.setValueAtTime(1, start);
  dry.gain.linearRampToValueAtTime(0, end);

  const wet = ctx.createGain();
  wet.gain.setValueAtTime(0.15, start);
  wet.gain.linearRampToValueAtTime(0.9, end);

  const reverb = makeReverb();
  lowpass.connect(dry);
  lowpass.connect(reverb);
  reverb.connect(wet);
  dry.connect(master);
  wet.connect(master);
  playSource(recording, lowpass, start, duration);

  await wait(duration + tail, signal);
}

// ---------- Interactions ----------

function openMicrophone() {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
}

// Shows Record, then Stop. Resolves with the decoded recording (never played back here),
// or null if the step is skipped.
function recordUser(signal) {
  return new Promise((resolve, reject) => {
    const recordBtn = $('record-btn');
    const stopBtn = $('stop-btn');
    const timer = $('record-timer');
    const chunks = [];
    let stream;
    let recorder;
    let tick;
    let cap;
    let discarded = false;

    const cleanup = () => {
      clearInterval(tick);
      clearTimeout(cap);
      stream?.getTracks().forEach((t) => t.stop());
      recordBtn.onclick = null;
      stopBtn.onclick = null;
    };

    signal.addEventListener('abort', () => {
      discarded = true;
      if (recorder?.state === 'recording') recorder.stop();
      cleanup();
      resolve(null);
    }, { once: true });

    recordBtn.hidden = false;
    stopBtn.hidden = true;
    timer.hidden = true;
    showPanel('record-panel');
    setStatus('Press Record when you are ready.');

    recordBtn.onclick = async () => {
      recordBtn.onclick = null;
      try {
        stream = await openMicrophone();
      } catch (err) {
        reject(new Error('Microphone is not available.'));
        return;
      }
      if (discarded) return cleanup();

      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = async () => {
        cleanup();
        if (discarded) return;
        showPanel(null);
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType });
          resolve(await ctx.decodeAudioData(await blob.arrayBuffer()));
        } catch (err) {
          reject(new Error('Could not read the recording.'));
        }
      };
      recorder.start();

      const began = Date.now();
      timer.textContent = '0:00';
      tick = setInterval(() => {
        const s = Math.floor((Date.now() - began) / 1000);
        timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }, 250);
      cap = setTimeout(() => recorder.state === 'recording' && recorder.stop(), MAX_RECORD_SECONDS * 1000);

      recordBtn.hidden = true;
      stopBtn.hidden = false;
      timer.hidden = false;
      setStatus('Recording… press Stop when you are done.');
      stopBtn.onclick = () => recorder.state === 'recording' && recorder.stop();
    };
  });
}

// Resolves 'donate' or 'delete', or null if the step is skipped.
function askChoice(signal) {
  return new Promise((resolve) => {
    showPanel('choice-panel');
    setStatus('');
    const pick = (value) => { showPanel(null); resolve(value); };
    $('donate-btn').onclick = () => pick('donate');
    $('delete-btn').onclick = () => pick('delete');
    signal.addEventListener('abort', () => resolve(null), { once: true });
  });
}

// ---------- Flow ----------

// Each step plays one thing (plus the pause after it). The arrows jump between these.
const STEPS = [
  { label: 'Narration v1', run: async (s) => { await playNarration('intro', s); await wait(GAP_SECONDS, s); } },
  { label: 'Distorted sound', run: async (s) => { await playDistorted(library, s); await wait(GAP_SECONDS, s); } },
  { label: 'Narration v2', run: (s) => playNarration('record', s) },
  { label: 'Record', run: async (s) => {
    recording = (await recordUser(s)) ?? recording;
    setStatus('Listen.');
    await wait(GAP_SECONDS, s);
  } },
  { label: 'Narration 3', run: async (s) => { await playNarration('clear', s); await wait(GAP_SECONDS, s); } },
  { label: 'Clear sound', run: async (s) => { await playClear(library, s); await wait(GAP_SECONDS, s); } },
  { label: 'Narration v4', run: (s) => playNarration('choice', s) },
  { label: 'Donate / Delete', run: async (s) => {
    choice = (await askChoice(s)) ?? choice;
    setStatus('Listen.');
  } },
  { label: () => (choice === 'donate' ? 'Narration 4A2' : 'Narration 4B'), run: async (s) => {
    await playNarration(choice, s);
    await wait(GAP_SECONDS, s);
  } },
  { label: () => (choice === 'donate' ? 'Blended sound' : 'Dissolving sound'), run: async (s) => {
    if (!recording) {
      setStatus('No recording yet. Go back to the Record step.');
    } else if (choice === 'donate') {
      await playBlend(library, recording, s);
    } else {
      await playDissolve(recording, s);
    }
    await wait(GAP_SECONDS, s);
  } },
  { label: 'Narration 6', run: (s) => playNarration('end', s) },
  { label: 'Thank you', run: () => {
    setStatus('');
    showPanel('thanks-panel');
    return new Promise(() => {}); // stays here until refresh
  } },
];

function updateStepNav() {
  const step = STEPS[stepIndex];
  const label = typeof step.label === 'function' ? step.label() : step.label;
  $('step-label').textContent = `${stepIndex + 1}/${STEPS.length} · ${label}`;
  $('prev-btn').disabled = stepIndex === 0;
  $('next-btn').disabled = stepIndex === STEPS.length - 1;
}

// Stops whatever the current step is doing and silences its audio.
function abortCurrentStep() {
  if (!stepController) return;
  stepController.abort();
  const out = stepOut;
  out.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
  setTimeout(() => out.disconnect(), 200);
}

async function runFrom(index) {
  abortCurrentStep();
  stepIndex = index;
  while (stepIndex < STEPS.length) {
    const controller = new AbortController();
    stepController = controller;
    stepOut = new GainNode(ctx);
    stepOut.connect(ctx.destination);
    showPanel(null);
    setStatus('Listen.');
    updateStepNav();

    await STEPS[stepIndex].run(controller.signal);
    if (controller.signal.aborted) return; // a newer runFrom took over
    stepIndex++;
  }
}

function handleError(err) {
  console.error(err);
  showPanel(null);
  setStatus(`Something went wrong: ${err.message} Refresh the page to try again.`);
}

async function start() {
  showPanel(null);
  setStatus('Loading…');

  ctx = new AudioContext();
  await ctx.resume();
  reverbImpulse = makeReverbImpulse();

  [library] = await Promise.all([loadRandomLibrarySound(), loadNarrations()]);

  // Ask for microphone permission up front so the prompt doesn't interrupt the experience.
  (await openMicrophone()).getTracks().forEach((t) => t.stop());

  $('step-nav').hidden = false;
  await runFrom(0);
}

$('start-btn').onclick = () => start().catch(handleError);
$('prev-btn').onclick = () => runFrom(stepIndex - 1).catch(handleError);
$('next-btn').onclick = () => runFrom(stepIndex + 1).catch(handleError);
