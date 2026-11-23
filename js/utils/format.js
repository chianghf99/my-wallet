// js/utils/format.js

// 依本地時區回傳 'YYYY-MM-DD'，不可用 toISOString() —— 它會先轉成 UTC，
// 在台北（UTC+8）早上 00:00~07:59 或月底 00:00:00 會倒退一天。
export const getLocalDate = (d = new Date()) => {
    const dt = d instanceof Date ? d : new Date(d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

// 產生「每月獲利總結」用的月底邊界陣列（長度為 monthsCount + 1，從當月底往回排）。
// 刻意在本地組出各月最後一日的 YYYY-MM-DD，避免 new Date(y, m+1, 0).toISOString()
// 因 UTC-8 小時把月底退成前一天（例如 11/30 變 11/29），導致月底當天的交易算到下個月。
export const getMonthEndDates = (monthsCount, baseDate = new Date()) => {
    const out = [];
    for (let i = 0; i <= monthsCount; i++) {
        const d = new Date(baseDate.getFullYear(), baseDate.getMonth() - i + 1, 0);
        out.push(getLocalDate(d));
    }
    return out;
};

// 判斷起始日當天的外部資金進出是否該計入期間淨流入：
// 若起始日快照時間早於交易時間（代表先拍完快照才匯錢），則須計入 netFlow 扣除；
// 若兩者缺少毫秒時戳，保守不計入（維持原有行為）。
export const isFlowAfterStartSnapshot = (txDate, startDate, txTsMs, startSnapTsMs) => {
    if (!txDate || !startDate) return false;
    if (txDate > startDate) return true;
    if (txDate < startDate) return false;
    return Number.isFinite(txTsMs) && Number.isFinite(startSnapTsMs) && txTsMs > startSnapTsMs;
};

export const formatNumber = (n) => 
    !n && n !== 0 ? '-' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 5 }).format(n);

export const formatCurrency = (n, c) => { 
    if (n === null || n === undefined || n === '') return (c === 'TWD' ? 'NT$ -' : '$ -');
    const val = Number(n);
    if (isNaN(val)) return (c === 'TWD' ? 'NT$ -' : '$ -');
    return (c === 'TWD' ? 'NT$ ' : '$ ') + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val); 
};

export const getPnlClass = (v) => v >= 0 ? 'text-up' : 'text-down';

export const getRoi = (c, p) => c === 0 ? '0%' : (p > 0 ? '+' : '') + (p / c * 100).toFixed(2) + '%';

export const formatChange = (diff, prev) => { 
    if (diff === null || diff === undefined || isNaN(diff)) return '-';
    const rounded = Math.abs(diff) < 0.1 ? Number(diff.toFixed(4)) : Number(diff.toFixed(2));
    const formattedDiff = formatNumber(rounded);
    if (prev === undefined || prev === null || prev === 0 || isNaN(prev)) {
        return (diff > 0 ? '+' : '') + formattedDiff;
    }
    const pct = (diff / prev) * 100; 
    return (diff > 0 ? '+' : '') + formattedDiff + ' (' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%)'; 
};

export const getTypeName = (type) => { 
    if (type === 'buy') return '買入'; 
    if (type === 'sell') return '賣出'; 
    if (type === 'dividend') return '領息'; 
    if (type === 'deposit') return '入金'; 
    if (type === 'withdraw') return '出金'; 
    if (type === 'borrow') return '借款'; 
    if (type === 'repay') return '還款'; 
    return type; 
};

export const getAmountSign = (tx) => { 
    if (tx.type === 'buy' || tx.type === 'withdraw' || tx.type === 'repay') return '-'; 
    return '+'; 
};

export const getFuturesDisplayName = (sym) => {
    if (!sym) return '';
    const upperSym = sym.toUpperCase();
    if (upperSym === 'MARGIN') return '保證金帳戶';
    if (upperSym.startsWith('MTX') || upperSym.startsWith('MXF')) return '小台指';
    if (upperSym.startsWith('TX')) return '大台指';
    if (upperSym.startsWith('TMF')) return '微台指';
    if (upperSym.startsWith('CDF')) return '台積期';
    if (upperSym.startsWith('QDF')) return '小台積期';
    return sym;
};

