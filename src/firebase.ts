import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAX9m_YIT2w1MbgrtEbRKaIbZsL3Q-tkZo",
  authDomain: "walkie-talkie-2f120.firebaseapp.com",
  projectId: "walkie-talkie-2f120",
  storageBucket: "walkie-talkie-2f120.firebasestorage.app",
  messagingSenderId: "836363190026",
  appId: "1:836363190026:web:53705bbd8f7bb0f8a344f3",
  measurementId: "G-EJQ40G14WE"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const signInWithGoogle = async () => {
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (error) {
    console.error("Error signing in with Google", error);
    throw error;
  }
};

export const logout = async () => {
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Error signing out", error);
  }
};
