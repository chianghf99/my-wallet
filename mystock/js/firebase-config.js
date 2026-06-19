// js/firebase-config.js
export const firebaseConfig = {
    apiKey: "AIzaSyAh94_Z-wA_riNIXmn_btCXbTtaZny1CQg",
    authDomain: "stock-portfolio-df6dd.firebaseapp.com",
    projectId: "stock-portfolio-df6dd",
    storageBucket: "stock-portfolio-df6dd.firebasestorage.app",
    messagingSenderId: "753606247346",
    appId: "1:753606247346:web:af0d0460327afb40f31aab",
    measurementId: "G-TGV1QF9QBG"
};

// Initialize Firebase (Assuming firebase is loaded globally via CDN)
firebase.initializeApp(firebaseConfig);

export const db = firebase.firestore();
export const auth = firebase.auth();
