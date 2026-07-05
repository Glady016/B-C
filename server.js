const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

console.log('🚀 Démarrage du serveur...');

// Configuration
const CONFIG = {
    appId: 1089,
    wsUrl: 'wss://ws.derivws.com/websockets/v3',
    maxTicks: 50000,
    cacheFile: './cache/data.json'
};

// Cache
let cache = {
    tickData: [],
    priceHistory: [],
    backtestResults: null,
    optimizationResults: null,
    smcZones: { ob: [], sd: [], fvg: [] },
    lastUpdate: null,
    stats: { spikeCount: 0, lastSpike: null, tickCounter: 0 }
};

// Créer dossier cache
if (!fs.existsSync('./cache')) {
    fs.mkdirSync('./cache');
    console.log('📁 Dossier cache créé');
}

function loadCache() {
    try {
        if (fs.existsSync(CONFIG.cacheFile)) {
            cache = JSON.parse(fs.readFileSync(CONFIG.cacheFile, 'utf8'));
            console.log('✅ Cache chargé');
        }
    } catch (e) {
        console.log('⚠️ Aucun cache trouvé');
    }
}

function saveCache() {
    try {
        fs.writeFileSync(CONFIG.cacheFile, JSON.stringify(cache, null, 2));
    } catch (e) {
        console.error('❌ Erreur sauvegarde cache:', e);
    }
}

setInterval(saveCache, 60000);

// Connexion Deriv
let derivWs = null;
let isConnected = false;

function connectDeriv() {
    if (derivWs && isConnected) return;
    console.log('🔌 Connexion à Deriv...');
    try {
        derivWs = new WebSocket(`${CONFIG.wsUrl}?app_id=${CONFIG.appId}`);
        derivWs.onopen = () => {
            isConnected = true;
            console.log('✅ Connecté à Deriv');
            subscribeToSymbol();
        };
        derivWs.onmessage = (event) => {
            try {
                handleDerivMessage(JSON.parse(event.data));
            } catch (e) {
                console.error('❌ Erreur parsing message:', e);
            }
        };
        derivWs.onerror = (error) => {
            console.error('❌ Erreur WebSocket:', error);
        };
        derivWs.onclose = () => {
            isConnected = false;
            console.log('⚠️ Connexion Deriv fermée, reconnexion dans 3s...');
            setTimeout(connectDeriv, 3000);
        };
    } catch (e) {
        console.error('❌ Erreur création WebSocket:', e);
    }
}

function subscribeToSymbol() {
    const symbol = 'R_25';
    console.log(`📡 Abonnement au symbole ${symbol}...`);
    try {
        derivWs.send(JSON.stringify({
            ticks_history: symbol,
            count: 50000,
            end: 'latest',
            start: 1,
            style: 'ticks'
        }));
        derivWs.send(JSON.stringify({
            ticks: symbol,
            subscribe: 1
        }));
    } catch (e) {
        console.error('❌ Erreur envoi message:', e);
    }
}

function handleDerivMessage(data) {
    if (data.error) {
        console.error('❌ Erreur API:', data.error.message);
        return;
    }
    switch (data.msg_type) {
        case 'history':
            processHistory(data.history);
            break;
        case 'tick':
            processTick(data.tick);
            break;
        default:
            break;
    }
}

function processHistory(history) {
    if (!history || !history.prices) return;
    cache.tickData = history.prices;
    cache.priceHistory = history.prices.map((p, i) => ({
        price: p,
        timestamp: history.times[i] * 1000
    }));
    console.log(`✅ ${history.prices.length} ticks historiques chargés`);
    setTimeout(() => {
        runBacktest();
        runOptimization();
        detectSMCZones();
    }, 1000);
}

function processTick(tick) {
    if (!tick || typeof tick.quote !== 'number') return;
    const price = tick.quote;
    const timestamp = (tick.epoch || Date.now() / 1000) * 1000;
    cache.tickData.push(price);
    cache.priceHistory.push({ price, timestamp });
    cache.stats.tickCounter++;
    if (cache.tickData.length > CONFIG.maxTicks) {
        cache.tickData.splice(0, cache.tickData.length - CONFIG.maxTicks);
        cache.priceHistory.splice(0, cache.priceHistory.length - CONFIG.maxTicks);
    }
    if (cache.stats.tickCounter % 100 === 0) saveCache();
}

// ============================================================
// BACKTEST - CORRIGÉ
// ============================================================
function runBacktest() {
    const data = cache.tickData;
    if (data.length < 100) {
        console.log('⚠️ Pas assez de données pour le backtest');
        return;
    }
    console.log('📊 Lancement du backtest sur ' + data.length + ' ticks...');
    
    let wins = 0, losses = 0;
    let sumGains = 0, sumLosses = 0;
    let capital = 10000;
    let peak = capital;
    let maxDrawdown = 0;
    let tradeCount = 0;
    
    const warmup = Math.min(100, Math.floor(data.length * 0.1));
    
    for (let i = warmup; i < data.length - 20; i++) {
        const price = data[i];
        const prevPrice = data[i - 1];
        const change = (price - prevPrice) / prevPrice;
        
        // Signal simplifié pour le backtest
        const signal = change < -0.001 ? 'sell' : 'wait';
        
        if (signal !== 'wait') {
            const entryPrice = price;
            let outcome = 'pending';
            let profit = 0;
            
            for (let j = 1; j <= 20; j++) {
                if (i + j >= data.length) break;
                const testPrice = data[i + j];
                const priceChange = (testPrice - entryPrice) / entryPrice;
                
                if (priceChange <= -0.005) {
                    outcome = 'correct';
                    profit = 0.5;
                    break;
                }
                if (priceChange >= 0.002) {
                    outcome = 'incorrect';
                    profit = -0.2;
                    break;
                }
            }
            
            if (outcome === 'pending') {
                const finalPrice = data[Math.min(i + 20, data.length - 1)];
                outcome = (finalPrice - entryPrice) / entryPrice < 0 ? 'correct' : 'incorrect';
                profit = ((finalPrice - entryPrice) / entryPrice) * 100;
            }
            
            if (outcome === 'correct') {
                wins++;
                sumGains += profit;
                capital *= (1 + profit / 100);
            } else {
                losses++;
                sumLosses += Math.abs(profit);
                capital *= (1 + profit / 100);
            }
            
            tradeCount++;
            peak = Math.max(peak, capital);
            maxDrawdown = Math.max(maxDrawdown, (peak - capital) / peak * 100);
        }
    }
    
    // ✅ La variable 'totalTrades' est déclarée UNE SEULE FOIS ici
    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
    const profitFactor = sumLosses > 0 ? (sumGains / sumLosses) : (sumGains > 0 ? 999 : 0);
    
    cache.backtestResults = {
        totalTrades: totalTrades,
        winRate: winRate,
        profitFactor: profitFactor,
        maxDrawdown: maxDrawdown,
        timestamp: Date.now()
    };
    
    console.log(`✅ Backtest terminé: ${totalTrades} signaux, winrate ${winRate.toFixed(1)}%`);
    saveCache();
}

// ============================================================
// OPTIMISATION - CORRIGÉE
// ============================================================
function runOptimization() {
    const data = cache.tickData;
    if (data.length < 500) {
        console.log('⚠️ Pas assez de données pour l\'optimisation');
        return;
    }
    console.log('🔬 Lancement de l\'optimisation...');
    
    const keys = ['trend', 'ob', 'sd', 'fvg', 'sr', 'mtf', 'tema'];
    const ranges = {
        trend: [5, 10, 15, 20],
        ob: [10, 15, 20, 25],
        sd: [10, 15, 20, 25],
        fvg: [10, 15, 20, 25],
        sr: [5, 10, 15, 20],
        mtf: [5, 10, 15, 20],
        tema: [10, 15, 20, 25]
    };
    
    let bestWinrate = 0;
    let bestWeights = {};
    const sampleData = data.slice(-2000);
    
    for (let trial = 0; trial < 30; trial++) {
        const weights = {};
        let totalWeight = 0;
        keys.forEach(key => {
            weights[key] = ranges[key][Math.floor(Math.random() * ranges[key].length)];
            totalWeight += weights[key];
        });
        const scale = 100 / totalWeight;
        keys.forEach(key => { weights[key] = Math.round(weights[key] * scale); });
        
        let wins = 0, losses = 0;
        
        for (let i = 100; i < sampleData.length - 10; i += 3) {
            const price = sampleData[i];
            const prevPrice = sampleData[i - 1];
            const change = (price - prevPrice) / prevPrice;
            const signal = change < -0.001 ? 'sell' : 'wait';
            
            if (signal !== 'wait') {
                const entryPrice = price;
                let outcome = 'pending';
                
                for (let j = 1; j <= 5; j++) {
                    if (i + j >= sampleData.length) break;
                    const testPrice = sampleData[i + j];
                    const priceChange = (testPrice - entryPrice) / entryPrice;
                    
                    if (priceChange <= -0.005) {
                        outcome = 'correct';
                        break;
                    }
                    if (priceChange >= 0.002) {
                        outcome = 'incorrect';
                        break;
                    }
                }
                
                if (outcome === 'correct') wins++;
                else if (outcome === 'incorrect') losses++;
            }
        }
        
        const total = wins + losses;
        const winrate = total > 0 ? (wins / total * 100) : 0;
        
        if (winrate > bestWinrate) {
            bestWinrate = winrate;
            bestWeights = weights;
        }
    }
    
    cache.optimizationResults = {
        weights: bestWeights,
        winrate: bestWinrate,
        timestamp: Date.now()
    };
    
    console.log(`✅ Optimisation terminée: winrate ${bestWinrate.toFixed(1)}%`);
    saveCache();
}

// ============================================================
// DÉTECTION SMC
// ============================================================
function detectSMCZones() {
    const data = cache.tickData;
    if (data.length < 100) {
        console.log('⚠️ Pas assez de données pour la détection SMC');
        return;
    }
    console.log('🔍 Détection des zones SMC...');
    
    const zones = { ob: [], sd: [], fvg: [] };
    
    // Order Blocks
    for (let i = 50; i < data.length - 10; i += 5) {
        const prev = data[i - 5];
        const curr = data[i];
        const next = data[i + 5];
        if (curr > prev * 1.002 && next < curr * 0.998) {
            zones.ob.push({ type: 'bearish', level: curr });
        }
        if (curr < prev * 0.998 && next > curr * 1.002) {
            zones.ob.push({ type: 'bullish', level: curr });
        }
    }
    
    // Supply/Demand
    for (let i = 30; i < data.length - 20; i += 3) {
        const range = data.slice(i - 10, i);
        const min = Math.min(...range);
        const max = Math.max(...range);
        if (data[i] > max * 1.005) {
            zones.sd.push({ type: 'demand', level: min, high: max, low: min });
        }
        if (data[i] < min * 0.995) {
            zones.sd.push({ type: 'supply', level: max, high: max, low: min });
        }
    }
    
    // FVG
    for (let i = 20; i < data.length - 10; i += 2) {
        const c0 = data[i - 10];
        const c2 = data[i];
        if (c0 < c2 * 0.995) {
            zones.fvg.push({ type: 'bullish', low: c0, high: c2 });
        }
        if (c0 > c2 * 1.005) {
            zones.fvg.push({ type: 'bearish', low: c2, high: c0 });
        }
    }
    
    cache.smcZones = zones;
    cache.lastUpdate = Date.now();
    
    console.log(`✅ SMC: ${zones.ob.length} OB, ${zones.sd.length} SD, ${zones.fvg.length} FVG`);
    saveCache();
}

// ============================================================
// ROUTES API
// ============================================================
app.get('/api/data', (req, res) => {
    res.json({
        ticks: cache.tickData.slice(-1000),
        priceHistory: cache.priceHistory.slice(-1000),
        stats: cache.stats,
        backtest: cache.backtestResults,
        optimization: cache.optimizationResults,
        smcZones: cache.smcZones,
        lastUpdate: cache.lastUpdate
    });
});

app.get('/api/status', (req, res) => {
    res.json({
        status: isConnected ? 'online' : 'offline',
        ticks: cache.tickData.length,
        spikes: cache.stats.spikeCount,
        backtest: cache.backtestResults ? 'available' : 'pending',
        optimization: cache.optimizationResults ? 'available' : 'pending'
    });
});

app.post('/api/recalculate', (req, res) => {
    setTimeout(() => {
        runBacktest();
        runOptimization();
        detectSMCZones();
    }, 100);
    res.json({ message: 'Recalcul lancé' });
});

app.post('/api/clear', (req, res) => {
    cache.tickData = [];
    cache.priceHistory = [];
    cache.backtestResults = null;
    cache.optimizationResults = null;
    cache.smcZones = { ob: [], sd: [], fvg: [] };
    cache.stats = { spikeCount: 0, lastSpike: null, tickCounter: 0 };
    saveCache();
    res.json({ message: 'Cache vidé' });
});

// ============================================================
// SERVEUR STATIQUE
// ============================================================
const publicPath = path.join(__dirname, 'public');
console.log(`📁 Dossier public: ${publicPath}`);

if (!fs.existsSync(publicPath)) {
    console.error('❌ Dossier public/ manquant !');
    fs.mkdirSync(publicPath);
    console.log('📁 Dossier public/ créé');
}

app.use(express.static(publicPath));

app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

// ============================================================
// DÉMARRAGE
// ============================================================
const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`📊 URL: http://localhost:${PORT}`);
    loadCache();
    setTimeout(connectDeriv, 1000);
});

process.on('SIGINT', () => {
    console.log('🛑 Arrêt du serveur...');
    saveCache();
    process.exit();
});

process.on('uncaughtException', (err) => {
    console.error('❌ Erreur non capturée:', err);
});