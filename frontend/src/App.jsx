import React, { useState, useEffect, useRef } from 'react';
import './App.css'; // This should point to your final CSS file

// Check for browser support for the Web Speech API
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;
if (recognition) {
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
}

const ChatMessage = ({ msg, onOptionClick, onConfirmationClick }) => {
    const isProductOptionMessage = msg.sender === 'bot' && msg.text.includes('\n- ');
    const isConfirmationMessage = msg.sender === 'bot' && msg.text.endsWith('Is this correct?');

    if (isConfirmationMessage) {
        const mainText = msg.text;
        return (
            <>
                <div className="message botMessage">{mainText}</div>
                <div className="optionsContainer">
                    <button className="optionButton" onClick={() => onConfirmationClick('confirm')}>
                        Confirm Order
                    </button>
                    <button className="optionButton" onClick={() => onConfirmationClick('cancel')}>
                        Cancel
                    </button>
                </div>
            </>
        );
    }

    if (isProductOptionMessage) {
        const parts = msg.text.split('\n- ');
        const mainText = parts[0];
        const options = parts.slice(1).map(opt => opt.trim());

        return (
            <>
                <div className="message botMessage">{mainText}</div>
                <div className="optionsContainer">
                    {options.map((option, index) => (
                        <button key={index} className="optionButton" onClick={() => onOptionClick(option)}>
                            {option}
                        </button>
                    ))}
                </div>
            </>
        );
    }
    
    return <div className={`message ${msg.sender === 'user' ? 'userMessage' : 'botMessage'}`}>{msg.text}</div>;
};

const ShoppingCart = ({ orderState }) => {
    if (!orderState) return null;

    const total = orderState.lineItems.reduce((sum, item) => sum + item.quantity * item.price, 0);

    return (
        <>
            <div className="cart-header">Current Order</div>
            <div className="cart-details">
                <p><strong>Shipping To:</strong> {orderState.shippingAddress || 'Not set'}</p>
                <p><strong>PO Number:</strong> {orderState.purchaseOrderNum || 'Not set'}</p>
            </div>
            <div className="cart-item-list">
                {orderState.lineItems.length === 0 ? (
                    <p className="empty-cart-message">Your cart is empty.</p>
                ) : (
                    orderState.lineItems.map((item, index) => (
                        <div key={index} className="cart-item">
                            <span className="cart-item-name">{item.name}</span>
                            <span className="cart-item-qty">{item.quantity} x</span>
                            <span className="cart-item-price">₹{item.price}</span>
                        </div>
                    ))
                )}
            </div>
            <div className="cart-summary">
                <div className="cart-total">
                    <span>Total</span>
                    <span>₹{total.toFixed(2)}</span>
                </div>
            </div>
        </>
    );
};


const App = () => {
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [userId, setUserId] = useState('');
    const [password, setPassword] = useState('');
    const [loginError, setLoginError] = useState('');

    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [orderState, setOrderState] = useState(null);
    const [isListening, setIsListening] = useState(false);
    const [recognitionLang, setRecognitionLang] = useState('en-US');
    const messagesEndRef = useRef(null);
    
    const isListeningRef = useRef(isListening);
    useEffect(() => {
        isListeningRef.current = isListening;
    }, [isListening]);

    const [theme, setTheme] = useState('dark');
    const [isCartOpen, setIsCartOpen] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const sheetRef = useRef(null);
    const dragStartY = useRef(0);

    useEffect(() => {
        document.body.className = theme === 'light' ? 'light-theme' : '';
    }, [theme]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(scrollToBottom, [messages]);
    
    const sendMessage = async (messageText, currentUserId, currentOrderState) => {
        if (!messageText.trim()) return;
        const userMessage = { text: messageText, sender: 'user' };
        
        setMessages(prevMessages => [...prevMessages, userMessage]);

        try {
            const response = await fetch('https://transactional-agent.onrender.com/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message: messageText, userId: currentUserId, orderState: currentOrderState }),
            });
            const data = await response.json();
            const botMessage = { text: data.reply, sender: 'bot' };
            
            setMessages(prevMessages => [...prevMessages, botMessage]);
            setOrderState(data.orderState);
        } catch (error) {
            console.error('Failed to send message:', error);
            const errorMessage = { text: "Sorry, I'm having trouble connecting. Please try again later.", sender: 'bot' };
            setMessages(prevMessages => [...prevMessages, errorMessage]);
        }
    };
    
    const handleLogin = async () => {
        if (!userId || !password) {
            setLoginError('Please enter a User ID and password.');
            return;
        }
        try {
            const response = await fetch(`https://transactional-agent.onrender.com/api/user/${userId}`);
            if (response.ok) {
                const userData = await response.json();
                setLoginError('');
                setIsLoggedIn(true);
                const initialOrderState = { customerId: userData.id, purchaseOrderNum: null, shippingAddress: null, lineItems: [], status: 'draft' };
                setOrderState(initialOrderState);
                
                sendMessage("hello", userData.id, initialOrderState);

            } else {
                setLoginError('User ID not found. Please try again.');
            }
        } catch (error) {
            setLoginError('Failed to connect to the server.');
        }
    };

    const handleLogout = () => {
        setIsLoggedIn(false);
        setUserId('');
        setPassword('');
        setMessages([]);
        setOrderState(null);
    };

    const handleSend = () => {
        sendMessage(input, userId, orderState);
        setInput('');
    };

    const handleOptionClick = (optionText) => {
        const messageToSend = `I'll take the ${optionText}`;
        sendMessage(messageToSend, userId, orderState);
    };

    const handleConfirmationClick = (choice) => {
        if (choice === 'confirm') {
            sendMessage("yes, finalize the order", userId, orderState);
        } else {
            sendMessage("cancel the order", userId, orderState);
        }
    };

    useEffect(() => {
        if (!recognition) return;

        recognition.onresult = (event) => {
            const transcript = event.results[event.results.length - 1][0].transcript;
            setInput(prevInput => prevInput + transcript);
        };

        recognition.onerror = (event) => {
            console.error("Speech recognition error", event.error);
            setIsListening(false);
        };

        recognition.onend = () => {
            if (isListeningRef.current) {
                recognition.start();
            }
        };
    }, []);

    const handleListen = () => {
        if (!recognition) {
            alert("Sorry, your browser does not support voice recognition.");
            return;
        }

        if (isListening) {
            recognition.stop();
            setIsListening(false);
        } else {
            recognition.lang = recognitionLang;
            recognition.start();
            setIsListening(true);
        }
    };

    const toggleLanguage = () => {
        setRecognitionLang(prevLang => prevLang === 'en-US' ? 'hi-IN' : 'en-US');
    };

    const toggleTheme = () => {
        setTheme(prevTheme => prevTheme === 'dark' ? 'light' : 'dark');
    };

    const onDragStart = (e) => {
        setIsDragging(true);
        dragStartY.current = e.touches ? e.touches[0].clientY : e.clientY;
        sheetRef.current.classList.remove('snapping');
    };

    const onDragMove = (e) => {
        if (!isDragging) return;
        const currentY = e.touches ? e.touches[0].clientY : e.clientY;
        const deltaY = currentY - dragStartY.current;
        const newHeight = isCartOpen ? window.innerHeight * 0.9 - deltaY : 80 - deltaY;
        
        const clampedHeight = Math.max(80, Math.min(window.innerHeight * 0.9, newHeight));
        sheetRef.current.style.height = `${clampedHeight}px`;
    };

    const onDragEnd = () => {
        setIsDragging(false);
        sheetRef.current.classList.add('snapping');
        const currentHeight = sheetRef.current.clientHeight;
        
        if (currentHeight > window.innerHeight * 0.5) {
            setIsCartOpen(true);
            sheetRef.current.style.height = '90vh';
        } else {
            setIsCartOpen(false);
            sheetRef.current.style.height = '80px';
        }
    };


    if (!isLoggedIn) {
        return (
            <div className="container">
                <div className="loginContainer">
                    <h2 className="loginHeader">B2B Order Portal</h2>
                    <input
                        type="text"
                        className="loginInput"
                        value={userId}
                        onChange={(e) => setUserId(e.target.value)}
                        placeholder="User ID"
                    />
                    <input
                        type="password"
                        className="loginInput"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && handleLogin()}
                        placeholder="Password"
                    />
                    <button onClick={handleLogin} className="loginButton">Login</button>
                    {loginError && <p className="loginError">{loginError}</p>}
                </div>
            </div>
        );
    }

    const totalItems = orderState?.lineItems.reduce((sum, item) => sum + item.quantity, 0) || 0;

    return (
        <div className="app-layout">
            <div className="chatContainer">
                <div className="header">
                    <span style={{flex: 1, textAlign: 'left'}}>
                        <button onClick={handleLogout} className="logout-button" title="Logout">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
                        </button>
                    </span>
                    <span style={{flex: 2, textAlign: 'center'}}>Conversational Order Placement</span>
                    <span style={{flex: 1, textAlign: 'right'}}>
                        <div className="header-controls">
                            <button onClick={toggleTheme} className="theme-toggle-button" title="Toggle Theme">
                                {theme === 'dark' ? '☀️' : '🌙'}
                            </button>
                        </div>
                    </span>
                </div>
                <div className="messagesArea">
                    {messages.map((msg, index) => (
                        <div key={index} className={`messageContainer ${msg.sender === 'user' ? 'userMessageContainer' : 'botMessageContainer'}`}>
                           <ChatMessage msg={msg} onOptionClick={handleOptionClick} onConfirmationClick={handleConfirmationClick} />
                        </div>
                    ))}
                    <div ref={messagesEndRef} />
                </div>
                <div className="inputArea">
                    <input
                        type="text"
                        className="input"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                        placeholder={isListening ? "Listening..." : "Type or click the mic to speak..."}
                    />
                    <button
                        onClick={toggleLanguage}
                        className="button langButton"
                        title="Toggle Language"
                    >
                        {recognitionLang === 'en-US' ? 'EN' : 'HI'}
                    </button>
                    <button
                        onClick={handleListen}
                        className="button micButton"
                        style={{backgroundColor: isListening ? 'var(--error-color)' : 'transparent'}}
                        title="Use Voice"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                            <line x1="12" y1="19" x2="12" y2="23"></line>
                        </svg>
                    </button>
                    <button
                        onClick={handleSend}
                        className="button sendButton"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
                    </button>
                </div>
            </div>
            
            {/* Desktop Sidebar */}
            <div className="cart-sidebar">
                <ShoppingCart orderState={orderState} />
            </div>

            {/* Mobile Bottom Sheet */}
            <div className="mobile-cart-container">
                <div className={`cart-backdrop ${isCartOpen ? 'open' : ''}`} onClick={() => setIsCartOpen(false)}></div>
                <div 
                    ref={sheetRef}
                    className={`cart-bottom-sheet ${isCartOpen ? 'open' : ''} ${isDragging ? '' : 'snapping'}`}
                >
                    <div 
                        className="cart-handle" 
                        onTouchStart={onDragStart}
                        onTouchMove={onDragMove}
                        onTouchEnd={onDragEnd}
                    ></div>
                    <div className="cart-peek-preview" onClick={() => setIsCartOpen(true)}>
                        <span>{isCartOpen ? '' : `View Order (${totalItems} items)`}</span>
                        <span>{isCartOpen ? '' : '↑'}</span>
                    </div>
                    {isCartOpen && <ShoppingCart orderState={orderState} />}
                </div>
            </div>
        </div>
    );
};

export default App;
