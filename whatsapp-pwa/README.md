# WhatsApp Summarizer — PWA

סיכום חכם לקבוצות וואצאפ עם Groq AI (חינמי).

## התקנה — 3 צעדים

### 1. העלה ל-GitHub
צור repository חדש ב-GitHub ועלה את כל הקבצים.

### 2. פרוס ל-Vercel
- כנס ל-[vercel.com](https://vercel.com)
- "Import Project" ← בחר את ה-repository
- לחץ Deploy — זהו!
- תקבל URL כמו `https://your-app.vercel.app`

### 3. התקן על הטלפון (Android)
- פתח את ה-URL בכרום
- תפריט ← "הוסף למסך הבית"
- האפליקציה מופיעה בשיתוף של וואצאפ!

## שימוש
1. קבל Groq API Key חינמי ב-[console.groq.com](https://console.groq.com/keys)
2. הכנס אותו בפעם הראשונה — נשמר אוטומטית
3. ייצא קבוצה מוואצאפ ← שתף לאפליקציה ← קבל סיכום

## קבצים
- `index.html` — האפליקציה המלאה
- `manifest.json` — הגדרות PWA + Share Target
- `sw.js` — Service Worker לשיתוף קבצים
- `vercel.json` — הגדרות פריסה
