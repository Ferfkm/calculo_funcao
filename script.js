(function() {
    'use strict';

    // ==================== CONFIGURAÇÕES E ESTADO ====================
    const canvas = document.getElementById('waveCanvas');
    // [6.3] fallback se getContext('2d') falhar
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        document.body.innerHTML =
            '<p style="color:#ff5555;font-family:monospace;padding:20px">' +
            'Seu navegador não suporta Canvas 2D.</p>';
        return;
    }

    const startBtn         = document.getElementById('startBtn');
    const stopBtn          = document.getElementById('stopBtn');
    const clearBtn         = document.getElementById('clearBtn');
    const zoomInBtn        = document.getElementById('zoomInBtn');
    const zoomOutBtn       = document.getElementById('zoomOutBtn');
    const zoomResetBtn     = document.getElementById('zoomResetBtn');
    const zoomLevel        = document.getElementById('zoomLevel');
    const statusMsg        = document.getElementById('statusMsg');

    const freqValue        = document.getElementById('freqValue');
    const amplitudeValue   = document.getElementById('amplitudeValue');
    const levelValue       = document.getElementById('levelValue');
    const periodValue      = document.getElementById('periodValue');
    const showFunctionBtn  = document.getElementById('showFunctionBtn');
    const funcValue        = document.getElementById('funcValue');
    const toggleWaveBtn    = document.getElementById('toggleWaveBtn');
    const functionOverlay  = document.getElementById('functionOverlay');

    if (!toggleWaveBtn || !functionOverlay) {
        console.warn('[WAVE] Elementos de UI ausentes: toggleWaveBtn e/ou functionOverlay.');
    }

    // Web Audio API
    let audioContext   = null;
    let analyserVis    = null;   // [2.1] visual (smoothing 0.85)
    let analyserRaw    = null;   // [2.1] medição (smoothing 0)
    let microphoneStream = null;
    let microphoneSource = null;
    let isRunning   = false;
    let isStarting  = false;
    let captureRequestId = 0;
    let animationId = null;

    // Dados do frame congelado
    let frozenTimeData = null;
    let frozenFreqData = null;
    let frozenSampleRate = 0;

    // [2.2] 8192 → ~186 ms @44.1kHz, bom para voz/instrumento.
    // Para tons longos pode-se subir para 16384.
    const FFT_SIZE = 8192;

    // Zoom
    let zoomFactor = 30.0;
    const ZOOM_MIN  = 1.0;
    const ZOOM_MAX  = 30.0;
    const ZOOM_STEP = 1.25;
    let panOffset = 0;

    const LIVE_WAVEFORM_INTERVAL_MS = 100;
    let lastWaveformDraw = 0;

    // [5.1][5.2] buffers pré-alocados
    let timeBuffer = null;
    let freqBuffer = null;

    // [5.3] cache da grade
    const gridCache = document.createElement('canvas');
    let lastGridKey = '';

    // [1.4] throttle de redesenho
    let redrawScheduled = false;
    let waveVisible = true;
    let lastLiveAnalysis = 0;
    const LIVE_ANALYSIS_INTERVAL_MS = 200;

    // ==================== CANVAS / DPR ====================
    // [4.6][7.1] ajusta o canvas ao tamanho real * devicePixelRatio
    function resizeCanvasToDisplaySize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width  * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width  = w;
            canvas.height = h;
            lastGridKey = '';  // força regenerar grade
            redrawCurrent();
        }
    }

    function getCanvasSize() {
        return { w: canvas.width, h: canvas.height };
    }

    // ==================== GRADE CACHEADO [5.3] ====================
    function renderGrid() {
        const w = canvas.width, h = canvas.height;
        gridCache.width  = w;
        gridCache.height = h;
        const g = gridCache.getContext('2d');
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);

        g.strokeStyle = '#00ffcc20';
        g.lineWidth = 1;

        for (let i = 0; i <= 4; i++) {
            const y = (h / 4) * i;
            g.beginPath();
            g.moveTo(0, y);
            g.lineTo(w, y);
            g.stroke();
        }
        const numV = Math.max(8, Math.round(8 * zoomFactor));
        for (let i = 0; i <= numV; i++) {
            const x = (w / numV) * i;
            g.beginPath();
            g.moveTo(x, 0);
            g.lineTo(x, h);
            g.stroke();
        }
    }

    function clearCanvas() {
        const key = `${canvas.width}x${canvas.height}@${zoomFactor.toFixed(3)}`;
        if (key !== lastGridKey) {
            lastGridKey = key;
            renderGrid();
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(gridCache, 0, 0);
    }

    // ==================== DESENHO ====================
    // [1.1] quadraticCurveTo usando ponto atual como controle e médio como destino
    // [5.4] desliga glow em zoom alto
    function drawWaveformWindowed(dataArray, color = '#00ffcc', lineWidth = 2.5, glow = true) {
        if (!dataArray || dataArray.length === 0) return;
        const { w, h } = getCanvasSize();
        const N = dataArray.length;

        const visibleCount = Math.max(2, Math.floor(N / zoomFactor));
        const maxStart = N - visibleCount;
        const start = Math.max(0, Math.min(maxStart, Math.floor(panOffset * maxStart)));
        const end = Math.min(N, start + visibleCount);
        const visibleSpan = end - start;
        const step = w / Math.max(1, visibleSpan - 1);

        const visualValueAt = i => {
            const before = dataArray[Math.max(start, i - 2)];
            const nearBefore = dataArray[Math.max(start, i - 1)];
            const current = dataArray[i];
            const nearAfter = dataArray[Math.min(end - 1, i + 1)];
            const after = dataArray[Math.min(end - 1, i + 2)];
            return (before + 4 * nearBefore + 6 * current + 4 * nearAfter + after) / 16;
        };
        let peak = 0;
        for (let i = start; i < end; i++) {
            peak = Math.max(peak, Math.abs(visualValueAt(i) - 128));
        }
        const displayPeak = Math.max(8, peak);
        const yOf = i => h / 2 - ((visualValueAt(i) - 128) / displayPeak) * h * 0.4;

        ctx.save();
        if (glow && zoomFactor < 8) {
            ctx.shadowColor = '#00ffcc';
            ctx.shadowBlur = 18;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2.5, lineWidth + 1.5);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        ctx.beginPath();
        ctx.moveTo(0, yOf(start));

        for (let i = start; i < end - 1; i++) {
            const x0 = Math.max(0, i - start - 1) * step;
            const x1 = (i - start) * step;
            const x2 = (i + 1 - start) * step;
            const x3 = Math.min(end - start - 1, i - start + 2) * step;
            const y0 = yOf(Math.max(start, i - 1));
            const y1 = yOf(i);
            const y2 = yOf(i + 1);
            const y3 = yOf(Math.min(end - 1, i + 2));
            const segmentMinY = Math.min(y1, y2);
            const segmentMaxY = Math.max(y1, y2);
            const controlY1 = y1 + (y2 - y0) / 6;
            const controlY2 = y2 - (y3 - y1) / 6;

            ctx.bezierCurveTo(
                x1 + (x2 - x0) / 6,
                Math.max(segmentMinY, Math.min(segmentMaxY, controlY1)),
                x2 - (x3 - x1) / 6,
                Math.max(segmentMinY, Math.min(segmentMaxY, controlY2)),
                x2,
                y2
            );
        }

        ctx.stroke();
        ctx.restore();
    }

    // [1.2] overlay de espectro (usa frozenFreqData)
    function drawSpectrumOverlay(freqData, w, h) {
        if (!freqData || freqData.length === 0) return;
        const bins = freqData.length;
        const barW = w / bins;
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = '#00ffcc';
        for (let i = 0; i < bins; i++) {
            const barH = (freqData[i] / 255) * h * 0.6;
            ctx.fillRect(i * barW, h - barH, Math.max(barW, 0.5), barH);
        }
        ctx.restore();
    }

    // ==================== ANÁLISE MATEMÁTICA ====================
    // [2.3] filtro passa-baixa IIR one-pole antes do zero-crossing
    function lowpass(samples, cutoffFrac) {
        const a = Math.exp(-2 * Math.PI * cutoffFrac);
        const out = new Float32Array(samples.length);
        let y = 0;
        for (let i = 0; i < samples.length; i++) {
            y = (1 - a) * samples[i] + a * y;
            out[i] = y;
        }
        return out;
    }

    function clearMeasurementValues() {
        freqValue.textContent = '— Hz';
        amplitudeValue.textContent = '—';
        levelValue.textContent = '— dBFS';
        periodValue.textContent = '— ms';
    }

    function analyzeFrozenFrame(timeData, freqData, sampleRate, isLive = false) {
        // [1.6] guarda length === 0
        if (!freqData || freqData.length === 0) {
            clearMeasurementValues();
            if (!isLive) statusMsg.textContent = '❌ Sem dados espectrais';
            return;
        }
        if (!timeData || timeData.length === 0) {
            clearMeasurementValues();
            if (!isLive) statusMsg.textContent = '❌ Sem dados temporais';
            return;
        }

        // ---------- 1) Pico do espectro ----------
        let peakIndex = 0, peakValue = 0;
        for (let i = 1; i < freqData.length; i++) {
            if (freqData[i] > peakValue) {
                peakValue = freqData[i];
                peakIndex = i;
            }
        }

        // [2.4] refinamento sub-bin por parábola
        let refinedPeak = peakIndex;
        if (peakIndex > 0 && peakIndex < freqData.length - 1) {
            const yL = freqData[peakIndex - 1];
            const y0 = freqData[peakIndex];
            const yR = freqData[peakIndex + 1];
            const denom = (yL - 2 * y0 + yR);
            if (denom !== 0) {
                refinedPeak = peakIndex + 0.5 * (yL - yR) / denom;
            }
        }

        const fftSize = freqData.length * 2;
        const frequency = refinedPeak * (sampleRate / fftSize);

        // ---------- 2) Normalizar e calcular RMS [1.5] ----------
        const N = timeData.length;
        const samples = new Float32Array(N);
        let sampleMean = 0;
        for (let i = 0; i < N; i++) {
            samples[i] = (timeData[i] - 128) / 128;
            sampleMean += samples[i];
        }
        sampleMean /= N;
        for (let i = 0; i < N; i++) samples[i] -= sampleMean;

        let sumSq = 0;
        for (let i = 0; i < N; i++) sumSq += samples[i] * samples[i];
        const rms = Math.sqrt(sumSq / N);
        const RMS_MIN = 0.005; // ~ -46 dBFS

        if (rms < RMS_MIN) {
            clearMeasurementValues();
            if (!isLive) {
                funcValue.textContent = '⚠ Sinal abaixo do limiar de detecção (silêncio/ruído).';
                funcValue.hidden = true;
                showFunctionBtn.hidden = false;
                showFunctionBtn.textContent = 'Mostrar detalhes';
                statusMsg.textContent = '⏸ Sinal insuficiente';
            }
            return;
        }

        // [4.9] detecção de clipping
        let clipped = false;
        let amplitude = 0;
        for (let i = 0; i < N; i++) {
            const sampleMagnitude = Math.abs(samples[i]);
            amplitude = Math.max(amplitude, sampleMagnitude);
            if (sampleMagnitude >= 0.985) clipped = true;
        }
        if (clipped) {
            statusMsg.textContent = '⚠ Sinal saturado — reduza o volume de entrada';
        }

        // ---------- 3) Zero-crossings sobre sinal filtrado [2.3] ----------
        const filtered = lowpass(samples, 0.12);
        const zeroCrossings = [];
        for (let i = 1; i < N; i++) {
            const prev = filtered[i - 1];
            const curr = filtered[i];
            if (prev < 0 && curr >= 0) {
                const frac = -prev / (curr - prev);
                zeroCrossings.push(i - 1 + frac);
            }
        }

        let freqFromZC = frequency;
        if (frequency > 0 && zeroCrossings.length > 1) {
            const periods = [];
            for (let i = 1; i < zeroCrossings.length; i++) {
                const period = zeroCrossings[i] - zeroCrossings[i - 1];
                if (period > 2 && period < N / 2) {
                    const crossingFrequency = sampleRate / period;
                    if (Math.abs(crossingFrequency - frequency) <= Math.max(5, frequency * 0.1)) {
                        periods.push(period);
                    }
                }
            }
            if (periods.length > 0) {
                const averagePeriod = periods.reduce((s, p) => s + p, 0) / periods.length;
                freqFromZC = sampleRate / averagePeriod;
            }
        }

        // [7.2] validação de faixa plausível
        const FREQ_MIN = 20, FREQ_MAX = 20000;
        if (!(freqFromZC >= FREQ_MIN && freqFromZC <= FREQ_MAX)) {
            clearMeasurementValues();
            if (!isLive) {
                funcValue.textContent = `⚠ Frequência fora da faixa audível (${freqFromZC.toFixed(0)} Hz).`;
                funcValue.hidden = true;
                showFunctionBtn.hidden = false;
                statusMsg.textContent = '⏸ Frequência fora da faixa';
            }
            return;
        }

        const levelDbfs = amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;

        freqValue.textContent = `${freqFromZC.toFixed(1)} Hz`;
        amplitudeValue.textContent = `${amplitude.toFixed(3)} (0–1)`;
        levelValue.textContent = `${levelDbfs.toFixed(1)} dBFS`;
        periodValue.textContent = `${(1000 / freqFromZC).toFixed(2)} ms`;

        if (!isLive) {
            funcValue.textContent =
                `y(t) = ${amplitude.toFixed(3)} · sen(2π · ${freqFromZC.toFixed(1)} · t)`;
            funcValue.title =
                'A é a amplitude de pico normalizada (0..1), f é a frequência em Hz e t é o tempo em segundos.';
            funcValue.hidden = true;
            functionOverlay.hidden = true;
            showFunctionBtn.hidden = false;
            showFunctionBtn.textContent = 'Mostrar função';
        }

        if (!isLive && !clipped) {
            statusMsg.textContent = `⏸ ${freqFromZC.toFixed(1)} Hz`;
        }

        // [7.4] log de diagnóstico
        logDiag('analyze', { rms, freqFromZC, amplitude, clipped });
    }

    function clearAnalysisResults() {
        clearMeasurementValues();
        funcValue.textContent = '—';
        funcValue.removeAttribute('title');
        funcValue.hidden = true;
        functionOverlay.hidden = true;
        showFunctionBtn.hidden = true;
        showFunctionBtn.textContent = 'Mostrar função';
    }

    // ==================== LOOP ====================
    function ensureBuffers() {
        if (!analyserVis) return false;
        if (!timeBuffer || timeBuffer.length !== analyserVis.fftSize) {
            timeBuffer = new Uint8Array(analyserVis.fftSize);
        }
        if (!freqBuffer || freqBuffer.length !== analyserVis.frequencyBinCount) {
            freqBuffer = new Uint8Array(analyserVis.frequencyBinCount);
        }
        return true;
    }

    function drawFrame() {
        if (!analyserVis || !isRunning) return;
        if (!ensureBuffers()) return;

        analyserVis.getByteTimeDomainData(timeBuffer);
        const now = performance.now();
        if (analyserRaw && now - lastLiveAnalysis >= LIVE_ANALYSIS_INTERVAL_MS) {
            analyserRaw.getByteFrequencyData(freqBuffer);
            analyzeFrozenFrame(timeBuffer, freqBuffer, audioContext.sampleRate, true);
            lastLiveAnalysis = now;
        }
        if (now - lastWaveformDraw < LIVE_WAVEFORM_INTERVAL_MS) {
            animationId = requestAnimationFrame(drawFrame);
            return;
        }
        lastWaveformDraw = now;
        clearCanvas();
        if (waveVisible) drawWaveformWindowed(timeBuffer, '#00ffcc', 2.5, true);

        animationId = requestAnimationFrame(drawFrame);
    }

    function redrawFrozen() {
        clearCanvas();
        if (waveVisible) {
            if (frozenFreqData) drawSpectrumOverlay(frozenFreqData, canvas.width, canvas.height);
            if (frozenTimeData) drawWaveformWindowed(frozenTimeData, '#00ffcc', 2.5, true);
        }
    }

    // [3.3] unifica o caminho de desenho
    function redrawCurrent() {
        if (isRunning) drawFrameOnce();
        else redrawFrozen();
    }

    // [1.4] throttle via rAF
    function scheduleRedraw() {
        if (redrawScheduled) return;
        redrawScheduled = true;
        requestAnimationFrame(() => {
            redrawScheduled = false;
            redrawCurrent();
        });
    }

    function drawFrameOnce() {
        if (!analyserVis || !ensureBuffers()) return;
        analyserVis.getByteTimeDomainData(timeBuffer);
        clearCanvas();
        if (waveVisible) drawWaveformWindowed(timeBuffer, '#00ffcc', 2.5, true);
    }

    // ==================== ÁUDIO ====================
    // [6.4] resume com retry
    async function ensureAudioReady() {
        if (!audioContext || audioContext.state === 'closed') {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        if (audioContext.state !== 'running') {
            throw new Error('Contexto de áudio bloqueado — clique novamente');
        }
    }

    async function startCapture() {
        if (isRunning || isStarting) return;
        const requestId = ++captureRequestId;
        isStarting = true;
        startBtn.disabled = true;
        try {
            statusMsg.textContent = '🎙 Solicitando acesso ao microfone...';

            // [6.1] mensagem específica para file://
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                const isFile = location.protocol === 'file:';
                throw new Error(isFile
                    ? 'Abra a página via https:// ou http://localhost — o navegador bloqueia microfone em file://'
                    : 'getUserMedia não disponível neste navegador');
            }

            microphoneStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });

            // [3.1] clearAll() durante o prompt — libera o stream que acabou de chegar
            if (requestId !== captureRequestId) {
                releaseMicrophone();
                if (audioContext && audioContext.state !== 'closed') {
                    try { await audioContext.close(); } catch (_) {}
                }
                audioContext = null;
                return;
            }

            await ensureAudioReady();
            if (requestId !== captureRequestId) {
                releaseMicrophone();
                return;
            }

            microphoneSource = audioContext.createMediaStreamSource(microphoneStream);

            // [2.1] dois analysers: um para visual, outro cru para medição
            analyserVis = audioContext.createAnalyser();
            analyserVis.fftSize = FFT_SIZE;
            analyserVis.smoothingTimeConstant = 0.85;

            analyserRaw = audioContext.createAnalyser();
            analyserRaw.fftSize = FFT_SIZE;
            analyserRaw.smoothingTimeConstant = 0.0;

            microphoneSource.connect(analyserVis);
            microphoneSource.connect(analyserRaw);

            frozenTimeData = null;
            frozenFreqData = null;
            frozenSampleRate = 0;
            lastLiveAnalysis = 0;
            lastWaveformDraw = 0;
            clearAnalysisResults();

            isRunning = true;
            stopBtn.disabled = false;
            statusMsg.textContent = '🎙 Capturando microfone...';
            statusMsg.style.color = '';

            if (animationId) cancelAnimationFrame(animationId);
            drawFrame();

            logDiag('startCapture', { sampleRate: audioContext.sampleRate });

        } catch (err) {
            if (requestId !== captureRequestId) return;
            // [7.4] log de erro
            console.error('[WAVE] startCapture error:', err);
            releaseMicrophone();
            analyserVis = analyserRaw = null;

            // [7.3] mapeamento completo de erros
            const errorMap = {
                NotAllowedError:      '❌ Permissão do microfone negada',
                PermissionDeniedError:'❌ Permissão do microfone negada',
                NotFoundError:        '❌ Nenhum microfone encontrado',
                DevicesNotFoundError: '❌ Nenhum microfone encontrado',
                NotReadableError:     '❌ Microfone em uso por outro aplicativo',
                TrackStartError:      '❌ Microfone em uso por outro aplicativo',
                OverconstrainedError: '❌ Restrições de áudio não suportadas',
                SecurityError:        '❌ Bloqueado por política de segurança (HTTPS obrigatório)',
                AbortError:           '❌ Captura abortada — tente novamente'
            };
            statusMsg.textContent = errorMap[err.name] || `❌ ${err.message || 'Erro ao acessar o microfone'}`;
            stopBtn.disabled = true;
            isRunning = false;
        } finally {
            isStarting = false;
            startBtn.disabled = isRunning;
        }
    }

    function releaseMicrophone() {
        if (microphoneSource) {
            try { microphoneSource.disconnect(); } catch (_) {}
            microphoneSource = null;
        }
        if (microphoneStream) {
            microphoneStream.getTracks().forEach(t => t.stop());
            microphoneStream = null;
        }
    }

    // [2.6] fecha o AudioContext quando fica ocioso
    async function closeAudioContextIfIdle() {
        if (audioContext && audioContext.state !== 'closed') {
            try { await audioContext.close(); } catch (_) {}
        }
        audioContext = null;
        analyserVis = analyserRaw = null;
    }

    async function stopAndAnalyze() {
        if (!isRunning || !analyserRaw) return;

        isRunning = false;
        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }

        // [3.2] exige sampleRate conhecido — sem fallback mentiroso
        if (!audioContext || audioContext.state === 'closed') {
            statusMsg.textContent = '❌ Contexto de áudio indisponível — reinicie a captura';
            stopBtn.disabled = true;
            startBtn.disabled = false;
            return;
        }
        const sampleRate = audioContext.sampleRate;

        // [2.1] puxa do analyser cru (smoothing = 0)
        const timeData = new Uint8Array(analyserRaw.fftSize);
        const freqData = new Uint8Array(analyserRaw.frequencyBinCount);
        analyserRaw.getByteTimeDomainData(timeData);
        analyserRaw.getByteFrequencyData(freqData);

        frozenTimeData = timeData;
        frozenFreqData = freqData;
        frozenSampleRate = sampleRate;

        releaseMicrophone();

        // [4.4] feedback visual antes do cálculo
        statusMsg.textContent = '⏳ Analisando...';
        statusMsg.style.color = '';
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        // [3.4] NÃO resetar zoom/pan — preserva enquadramento
        updateZoomLabel();

        analyzeFrozenFrame(frozenTimeData, frozenFreqData, sampleRate);
        redrawFrozen();

        startBtn.disabled = false;
        stopBtn.disabled = true;
    }

    function clearAll() {
        captureRequestId++;
        if (isRunning) {
            isRunning = false;
            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
            releaseMicrophone();
        }

        frozenTimeData = null;
        frozenFreqData = null;
        frozenSampleRate = 0;
        zoomFactor = 1.0;
        panOffset = 0;
        updateZoomLabel();

        clearCanvas();
        clearAnalysisResults();

        startBtn.disabled = false;
        stopBtn.disabled = true;
        statusMsg.textContent = '🔇 Pronto';
        statusMsg.style.color = '';

        // [2.6] libera o contexto de áudio
        closeAudioContextIfIdle();
    }

    // ==================== ZOOM ====================
    // [4.10] mostra faixa visível em ms
    function updateZoomLabel() {
        const sr = frozenSampleRate || audioContext?.sampleRate || 44100;
        const totalMs = frozenTimeData
            ? (frozenTimeData.length / sr) * 1000
            : (FFT_SIZE / sr) * 1000;
        const visibleMs = Math.round(totalMs / zoomFactor);
        zoomLevel.textContent = `${zoomFactor.toFixed(1)}× (${visibleMs} ms)`;

        zoomInBtn.disabled  = zoomFactor >= ZOOM_MAX;
        zoomOutBtn.disabled = zoomFactor <= ZOOM_MIN;

        // [4.1][4.2] classe para cursor grab/grabbing
        canvas.classList.toggle('zoomable', zoomFactor > 1.0);
    }

    // [1.3] zoom no cursor, não no centro
    function applyZoom(newZoom, mouseXFrac = 0.5) {
        newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
        if (newZoom === zoomFactor) return;

        const oldWidth = 1 / zoomFactor;
        const newWidth = 1 / newZoom;
        const anchor = panOffset + mouseXFrac * oldWidth;
        panOffset = Math.max(0, Math.min(1 - newWidth, anchor - mouseXFrac * newWidth));
        zoomFactor = newZoom;

        updateZoomLabel();
        scheduleRedraw();
    }

    // ==================== EVENTOS ====================
    startBtn.addEventListener('click', startCapture);
    stopBtn.addEventListener('click', stopAndAnalyze);
    clearBtn.addEventListener('click', clearAll);

    // [4.3] toggle mostrar/ocultar
    showFunctionBtn.addEventListener('click', () => {
        const showing = !funcValue.hidden;
        funcValue.hidden = showing;
        if (functionOverlay) {
            functionOverlay.textContent = funcValue.textContent.trim();
            functionOverlay.hidden = showing;
        }
        showFunctionBtn.textContent = showing ? 'Mostrar função' : 'Ocultar função';
    });
    if (toggleWaveBtn) {
        toggleWaveBtn.addEventListener('click', () => {
            waveVisible = !waveVisible;
            toggleWaveBtn.textContent = waveVisible ? 'Ocultar onda' : 'Mostrar onda';
            toggleWaveBtn.setAttribute('aria-pressed', String(!waveVisible));
            redrawCurrent();
        });
    }

    zoomInBtn.addEventListener('click',  () => applyZoom(zoomFactor * ZOOM_STEP, 0.5));
    zoomOutBtn.addEventListener('click', () => applyZoom(zoomFactor / ZOOM_STEP, 0.5));
    zoomResetBtn.addEventListener('click', () => {
        zoomFactor = 1.0;
        panOffset = 0;
        updateZoomLabel();
        scheduleRedraw();
    });

    // [1.3] zoom no cursor via wheel
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const xFrac = (e.clientX - rect.left) / rect.width;
        applyZoom(e.deltaY < 0 ? zoomFactor * ZOOM_STEP : zoomFactor / ZOOM_STEP, xFrac);
    }, { passive: false });

    // ---------- Mouse drag [1.4] com rAF throttle ----------
    let isDragging = false;
    let dragStartX = 0;
    let dragStartPan = 0;

    canvas.addEventListener('mousedown', (e) => {
        if (zoomFactor <= 1.0) return;
        isDragging = true;
        dragStartX = e.clientX;
        dragStartPan = panOffset;
    });
    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const rect = canvas.getBoundingClientRect();
        const dx = e.clientX - dragStartX;
        const visibleWidth = 1 / zoomFactor;
        const deltaFrac = -(dx / rect.width) * visibleWidth;
        panOffset = Math.max(0, Math.min(1 - visibleWidth, dragStartPan + deltaFrac));
        scheduleRedraw();   // [1.4]
    });
    window.addEventListener('mouseup', () => {
        isDragging = false;
    });

    // ---------- Touch [6.5] só bloqueia scroll quando zoom > 1 ----------
    let touchStartX = 0;
    let touchStartPan = 0;
    let isTouching = false;

    canvas.addEventListener('touchstart', (e) => {
        if (zoomFactor <= 1.0 || e.touches.length !== 1) return;
        isTouching = true;
        touchStartX = e.touches[0].clientX;
        touchStartPan = panOffset;
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
        if (!isTouching || zoomFactor <= 1.0 || e.touches.length !== 1) return;
        const rect = canvas.getBoundingClientRect();
        const dx = e.touches[0].clientX - touchStartX;
        const visibleWidth = 1 / zoomFactor;
        const deltaFrac = -(dx / rect.width) * visibleWidth;
        panOffset = Math.max(0, Math.min(1 - visibleWidth, touchStartPan + deltaFrac));
        scheduleRedraw();   // [1.4]
        e.preventDefault(); // só bloqueia scroll quando há zoom
    }, { passive: false });

    canvas.addEventListener('touchend', () => { isTouching = false; }, { passive: true });

    // ---------- Teclado [4.7] ----------
    canvas.addEventListener('keydown', (e) => {
        if (e.key === '+' || e.key === '=') {
            applyZoom(zoomFactor * ZOOM_STEP, 0.5);
            e.preventDefault();
        } else if (e.key === '-') {
            applyZoom(zoomFactor / ZOOM_STEP, 0.5);
            e.preventDefault();
        } else if (e.key === 'ArrowLeft' && zoomFactor > 1) {
            panOffset = Math.max(0, panOffset - 0.02 / zoomFactor);
            scheduleRedraw();
            e.preventDefault();
        } else if (e.key === 'ArrowRight' && zoomFactor > 1) {
            panOffset = Math.min(1 - 1 / zoomFactor, panOffset + 0.02 / zoomFactor);
            scheduleRedraw();
            e.preventDefault();
        } else if (e.key === '0') {
            zoomFactor = 1.0; panOffset = 0;
            updateZoomLabel(); scheduleRedraw();
            e.preventDefault();
        }
    });

    // ---------- Diagnóstico [7.4] ----------
    function logDiag(stage, extra = {}) {
        if (!window.__WAVE_DEBUG) return;
        console.debug('[WAVE]', stage, {
            sampleRate: audioContext?.sampleRate,
            fftSize: analyserVis?.fftSize,
            zoomFactor, panOffset, ...extra
        });
    }

    // ---------- ResizeObserver [4.6][7.1] ----------
    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => resizeCanvasToDisplaySize());
        ro.observe(canvas.parentElement);
    }
    window.addEventListener('resize', resizeCanvasToDisplaySize);

    // ---------- Inicialização ----------
    zoomFactor = 12.0;
    panOffset = 0;
    updateZoomLabel();
    resizeCanvasToDisplaySize();
    clearCanvas();
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
})();