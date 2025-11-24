import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore'; // Included for completeness

// --- Configuration and Constants ---
const MODEL_NAME_TEXT = "gemini-2.5-flash-preview-09-2025";
const MODEL_NAME_MULTIMODAL = "gemini-2.5-flash-preview-09-2025"; // Can handle text and image
const API_KEY = ""; // Placeholder, will be provided by environment
const API_URL_TEXT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME_TEXT}:generateContent?key=${API_KEY}`;
const API_URL_MULTIMODAL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME_MULTIMODAL}:generateContent?key=${API_KEY}`;

// Load environment variables for Firebase
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// Response Schema for structured output
const analysisSchema = {
    type: "OBJECT",
    properties: {
        textWithErrorsHighlighted: {
            type: "STRING",
            description: "The original text with HTML <span> tags injected around detected errors (grammatical, spelling, punctuation), using the class 'error-highlight'. Example: The cow <span class=\"error-highlight\">eat</span> grass."
        },
        suggestedCorrections: { // Renamed and changed structure for error-correction pairs
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    originalError: { "type": "STRING", description: "The exact phrase or word highlighted as an error in textWithErrorsHighlighted." },
                    correctedText: { "type": "STRING", description: "The grammatically correct or improved text suggestion for the original error." }
                }
            },
            description: "A list of specific error-correction pairs found in the text."
        },
        headlinesAndSubheadlines: {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    headlineHindi: { "type": "STRING", description: "A catchy, journalistic headline written in Hindi." },
                    subheadlineHindi: { "type": "STRING", description: "A concise, supporting subheadline written in Hindi." }
                }
            }
        }
    },
    // Updated required list to use the new field name
    required: ["textWithErrorsHighlighted", "suggestedCorrections", "headlinesAndSubheadlines"]
};

// --- Main React Component ---
const App = () => {
    // Firebase States
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    // Application States
    const [inputText, setInputText] = useState('');
    const [imageFile, setImageFile] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [numHeadlines, setNumHeadlines] = useState(10); // Default 10
    const [currentAnalysis, setCurrentAnalysis] = useState(null);
    const [error, setError] = useState('');

    // 1. Firebase Initialization and Authentication
    useEffect(() => {
        if (Object.keys(firebaseConfig).length === 0) {
            console.error("Firebase config is missing.");
            return;
        }

        try {
            const app = initializeApp(firebaseConfig);
            const authInstance = getAuth(app);
            const dbInstance = getFirestore(app);
            setAuth(authInstance);
            setDb(dbInstance);

            const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
                if (!user) {
                    if (initialAuthToken) {
                        try {
                            await signInWithCustomToken(authInstance, initialAuthToken);
                        } catch (e) {
                            console.error("Error signing in with custom token:", e);
                            await signInAnonymously(authInstance);
                        }
                    } else {
                        await signInAnonymously(authInstance);
                    }
                }
                setUserId(authInstance.currentUser?.uid);
                setIsAuthReady(true);
            });

            return () => unsubscribe();
        } catch (e) {
            console.error("Firebase initialization failed:", e);
        }
    }, []);


    // Utility to convert file to base64
    const fileToBase64 = (file) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = (error) => reject(error);
        });
    };

    // 2. Main Analysis Logic (Fetch Gemini)
    const fetchGeminiAnalysis = useCallback(async (base64Image = null, textInput = '') => {
        if (!textInput && !base64Image) {
            setError("Please provide text or an image to analyze.");
            return;
        }

        setIsLoading(true);
        setError('');

        // UPDATED PROMPT for specific corrections
        const prompt = `You are a professional newspaper editor and language analyst. Your task is to analyze the provided article text.
        1. **Error Highlighting**: Identify grammatical, spelling, and minor factual errors. Return the ORIGINAL text, but wrap all error words or phrases in a span with the CSS class 'error-highlight' (defined as text-red-600 font-bold). DO NOT correct the text here.
        2. **Suggested Corrections**: For every grammatical, spelling, or factual error identified in the text, provide the exact original erroneous word/phrase and the single, best corrected word/phrase suggestion for it.
        3. **Hindi Headlines**: Provide ${numHeadlines} sets of catchy, journalistic headlines and subheadlines written *exclusively* in **Hindi**.
        4. **Article Text**: ${textInput}`;

        let contents = [];
        let apiUrl = API_URL_TEXT;

        if (base64Image) {
            apiUrl = API_URL_MULTIMODAL;
            const imagePart = {
                inlineData: {
                    mimeType: imageFile.type,
                    data: base64Image
                }
            };

            const imagePrompt = `First, transcribe the text from this image accurately. Once transcribed, perform the following analysis on the transcribed text: ${prompt}`;
            contents.push({ parts: [{ text: imagePrompt }, imagePart] });
        } else {
            contents.push({ parts: [{ text: prompt }] });
        }

        const payload = {
            contents: contents[0].parts.length > 0 ? contents : [{ parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: analysisSchema
            },
            systemInstruction: {
                parts: [{ text: "You are a world-class language model specializing in editorial analysis and multilingual (Hindi) content creation. Your output MUST be valid JSON according to the provided schema." }]
            }
        };

        const maxRetries = 3;
        let lastError = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const result = await response.json();
                const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;

                if (!jsonText) {
                     // Check for block reason
                    if (result.candidates?.[0]?.finishReason === 'SAFETY') {
                        throw new Error("AI output was blocked due to safety settings. Please adjust the input text.");
                    }
                    throw new Error("AI returned no JSON content. The prompt might be too complex or the model failed.");
                }

                // Clean the JSON string and parse
                const cleanedJsonText = jsonText.replace(/```json|```/g, '').trim();
                const parsedJson = JSON.parse(cleanedJsonText);
                setCurrentAnalysis(parsedJson);
                setIsLoading(false);
                return; // Success
            } catch (e) {
                lastError = e;
                console.error(`Attempt ${attempt + 1} failed:`, e);
                if (attempt < maxRetries - 1) {
                    const delay = Math.pow(2, attempt) * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        setIsLoading(false);
        setError(`Analysis failed after ${maxRetries} attempts. Error: ${lastError.message}`);

    }, [imageFile, numHeadlines, API_URL_TEXT, API_URL_MULTIMODAL]);

    // 3. User Interaction Handlers
    const handleAnalyze = async (refreshImprovements = false) => {
        if (!inputText && !imageFile) {
            setError("Please paste text or select an image.");
            return;
        }

        let base64 = null;
        if (imageFile) {
            try {
                base64 = await fileToBase64(imageFile);
            } catch (e) {
                setError("Failed to convert image to base64.");
                return;
            }
        }

        // To refresh suggested improvements/headlines, just re-run the analysis
        await fetchGeminiAnalysis(base64, inputText);
    };

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (file) {
            setImageFile(file);
            setInputText(`--- Image file selected: ${file.name} --- (Content will be transcribed by AI)`);
        } else {
            setImageFile(null);
            setInputText('');
        }
    };

    // 4. Component Rendering
    const OutputBox = ({ title, children, className = '' }) => (
        <div className={`p-4 bg-white shadow-lg rounded-xl transition-all duration-300 h-full flex flex-col ${className}`}>
            <h3 className="text-lg font-semibold text-gray-800 border-b pb-2 mb-3">{title}</h3>
            <div className="flex-grow overflow-y-auto">
                {children}
            </div>
        </div>
    );

    return (
        <div className="min-h-screen bg-gray-50 p-4 sm:p-8 font-sans">
            <style jsx="true">{`
                .error-highlight {
                    color: #dc2626; /* Red 600 */
                    font-weight: 700;
                    text-decoration: underline wavy #ef4444;
                }
            `}</style>

            <header className="text-center mb-8">
                <h1 className="text-4xl font-extrabold text-indigo-700 mb-2">
                    Reporter's AI Editing Desk
                </h1>
                <p className="text-gray-600">
                    Paste your article or upload an image for instant analysis and Hindi headline suggestions.
                </p>
                <p className="text-xs text-gray-400 mt-2">
                    User ID: {userId || 'Authenticating...'} (App ID: {appId})
                </p>
            </header>

            {error && (
                <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-md mb-4" role="alert">
                    <strong className="font-bold">Error:</strong>
                    <span className="block sm:inline ml-2">{error}</span>
                </div>
            )}

            {/* Input Section */}
            <div className="bg-white p-6 shadow-2xl rounded-2xl mb-8">
                <h2 className="text-2xl font-bold text-gray-800 mb-4">Article Input</h2>
                <textarea
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 transition duration-150 resize-none"
                    rows="10"
                    placeholder="Paste your news article text here..."
                    value={inputText}
                    onChange={(e) => {
                        setInputText(e.target.value);
                        setImageFile(null); // Clear image if text is manually edited
                    }}
                    disabled={isLoading}
                />
                <div className="flex items-center justify-between mt-4 flex-wrap">
                    <label className="flex items-center space-x-2 bg-indigo-500 hover:bg-indigo-600 text-white font-semibold py-2 px-4 rounded-full cursor-pointer transition duration-200 shadow-md">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                        <span>{imageFile ? imageFile.name : 'Upload Image (for OCR)'}</span>
                        <input type="file" accept="image/*" className="hidden" onChange={handleFileChange} disabled={isLoading} />
                    </label>

                    <div className="flex items-center space-x-4 mt-2 sm:mt-0">
                        <label className="text-gray-600 font-medium">Headlines (5-25):</label>
                        <select
                            value={numHeadlines}
                            onChange={(e) => setNumHeadlines(Number(e.target.value))}
                            className="p-2 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
                            disabled={isLoading}
                        >
                            {Array.from({ length: 5 }, (_, i) => 5 + i * 4).map(n => (
                                <option key={n} value={n}>{n}</option>
                            ))}
                        </select>
                        <button
                            onClick={() => handleAnalyze(false)}
                            disabled={isLoading || (!inputText && !imageFile)}
                            className="bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-6 rounded-full transition duration-200 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                        >
                            {isLoading ? (
                                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                            ) : (
                                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 15l-2 5L9 9l5-2 2 5zm0 0l-2 5L9 9l5-2 2 5z"></path></svg>
                            )}
                            Analyze & Generate
                        </button>
                    </div>
                </div>
            </div>

            {/* Output Section (3 Boxes) */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 h-[70vh]">
                
                {/* Box 1: Errors in Text (Required to show errors) */}
                <OutputBox title="1. Original Text with Errors Highlighted (Red)" className="lg:col-span-1">
                    {currentAnalysis?.textWithErrorsHighlighted ? (
                        <p
                            className="text-gray-700 leading-relaxed whitespace-pre-wrap"
                            dangerouslySetInnerHTML={{ __html: currentAnalysis.textWithErrorsHighlighted }}
                        />
                    ) : (
                        <p className="text-gray-500 italic">{isLoading ? "Detecting errors..." : "Analysis result will appear here."}</p>
                    )}
                </OutputBox>

                {/* Box 2: Suggested Improvements (Now shows Corrections) */}
                <OutputBox title="2. Error Corrections (Original -> Suggested)" className="lg:col-span-1">
                    {currentAnalysis?.suggestedCorrections?.length > 0 ? (
                        <ul className="list-none space-y-3">
                            {currentAnalysis.suggestedCorrections.map((correction, index) => (
                                <li key={index} className="p-3 bg-white border border-gray-200 rounded-lg shadow-sm">
                                    <p className="text-sm text-gray-500 mb-1">Original Error:</p>
                                    <p className="text-lg font-semibold text-red-600 mb-2">
                                        "{correction.originalError}"
                                    </p>
                                    <p className="text-sm text-gray-500 mb-1">Suggested Correction:</p>
                                    <p className="text-lg font-semibold text-green-700">
                                        "{correction.correctedText}"
                                    </p>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-gray-500 italic">{isLoading ? "Generating error corrections..." : "Specific error-correction pairs will be listed here."}</p>
                    )}
                    <button
                        onClick={() => handleAnalyze(true)}
                        disabled={isLoading || !currentAnalysis}
                        className="mt-4 w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-4 rounded-lg transition duration-200 shadow-md disabled:opacity-50"
                    >
                        Refresh Corrections
                    </button>
                </OutputBox>

                {/* Box 3: Hindi Headlines (Required to select N and refresh) */}
                <OutputBox title={`3. Best Suggested Headlines & Subheadlines (Hindi - ${numHeadlines} Options)`} className="lg:col-span-1">
                    {currentAnalysis?.headlinesAndSubheadlines?.length > 0 ? (
                        <div className="space-y-4">
                            {currentAnalysis.headlinesAndSubheadlines.map((item, index) => (
                                <div key={index} className="border-b pb-2 last:border-b-0">
                                    <p className="text-xl font-bold text-green-700">{index + 1}. {item.headlineHindi}</p>
                                    <p className="text-base text-gray-600 italic">({item.subheadlineHindi})</p>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-gray-500 italic">{isLoading ? "Creating Hindi headline options..." : "Catchy headline/subheadline pairs in Hindi will appear here."}</p>
                    )}
                    <button
                        onClick={() => handleAnalyze(true)}
                        disabled={isLoading || !currentAnalysis}
                        className="mt-4 w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-2 px-4 rounded-lg transition duration-200 shadow-md disabled:opacity-50"
                    >
                        Refresh Headlines
                    </button>
                </OutputBox>

            </div>

        </div>
    );
}

export default App;
