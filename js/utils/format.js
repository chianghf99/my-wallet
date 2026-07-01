// js/utils/format.js

export const getLocalDate = () => {
    const d = new Date();
    const offset = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - offset).toISOString().split('T')[0];
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
    const pct = (diff / prev) * 100; 
    return (diff > 0 ? '+' : '') + diff.toFixed(2) + ' (' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%)'; 
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
