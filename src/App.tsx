import { FileSpreadsheet, MessageSquare, Plus, Send, Settings, Upload, Loader2, Database, MoreVertical, Trash2, Edit2 } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Chat {
  id: string;
  name: string;
  messages: Message[];
  datasetName: string | null;
}

export default function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const activeChat = chats.find(c => c.id === activeChatId);

  // ── Load conversation history from backend when switching chats ──
  useEffect(() => {
    if (!activeChatId) return;
    const currentChat = chats.find(c => c.id === activeChatId);
    if (!currentChat || currentChat.messages.length > 0) return; // already loaded

    fetch(`/api/history/${activeChatId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || !data.history || data.history.length === 0) return;
        const messages: Message[] = [];
        for (const turn of data.history) {
          // Each turn: "Kullanıcı: ...\nAsistan: ..."
          const userMatch = turn.match(/^Kullanıcı: ([\s\S]*?)\nAsistan:/);
          const assistantMatch = turn.match(/\nAsistan: ([\s\S]*)$/);
          if (userMatch) messages.push({ role: 'user',      content: userMatch[1].trim() });
          if (assistantMatch) messages.push({ role: 'assistant', content: assistantMatch[1].trim() });
        }
        if (messages.length > 0) {
          setChats(prev => prev.map(chat =>
            chat.id === activeChatId ? { ...chat, messages } : chat
          ));
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [activeChat?.messages]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
    };
    if (openMenuId) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openMenuId]);

  const handleRename = (id: string) => {
    if (editingName.trim()) {
      setChats(prev => prev.map(chat => 
        chat.id === id ? { ...chat, name: editingName.trim() } : chat
      ));
    }
    setEditingChatId(null);
  };

  const handleNewChat = () => {
    const newChat: Chat = {
      id: Date.now().toString(),
      name: `New Analysis ${chats.length + 1}`,
      messages: [],
      datasetName: null
    };
    setChats([...chats, newChat]);
    setActiveChatId(newChat.id);
  };

  const handleDeleteChat = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newChats = chats.filter(chat => chat.id !== id);
    if (newChats.length === 0) {
      setChats([]);
      setActiveChatId(null);
    } else {
      setChats(newChats);
      if (activeChatId === id) {
        setActiveChatId(newChats[0].id);
      }
    }
    setOpenMenuId(null);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !activeChatId) return;

    setIsUploading(true);
    setUploadError(null);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('chat_id', activeChatId);

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        setChats(prev => prev.map(chat => 
          chat.id === activeChatId 
            ? { ...chat, datasetName: data.filename, name: data.filename.split('.')[0] } 
            : chat
        ));
        setUploadError(null);
      } else {
        const errData = await response.json().catch(() => ({ detail: 'Sunucu hatası' }));
        setUploadError(errData.detail || 'Yükleme başarısız oldu.');
      }
    } catch {
      setUploadError('Backend\'e bağlanılamadı. Terminalde "npm run dev" komutunu çalıştırın (hem frontend hem backend otomatik başlar).');
    } finally {
      setIsUploading(false);
      // Reset the input value so selecting the same file again triggers onChange
      if (event.target) {
        event.target.value = '';
      }
    }
  };

  const handleSendMessage = async () => {
    if (!activeChat || !inputText.trim() || !activeChat.datasetName || isTyping) return;

    const userMessage: Message = { role: 'user', content: inputText };
    const updatedMessages = [...activeChat.messages, userMessage];
    
    setChats(prev => prev.map(chat => 
      chat.id === activeChatId ? { ...chat, messages: updatedMessages } : chat
    ));
    setInputText('');
    setIsTyping(true);

    try {
      const formData = new FormData();
      formData.append('chat_id', activeChatId);
      formData.append('query', userMessage.content);

      const response = await fetch('/api/chat', {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        const assistantMessage: Message = { role: 'assistant', content: data.response };
        setChats(prev => prev.map(chat => 
          chat.id === activeChatId ? { ...chat, messages: [...updatedMessages, assistantMessage] } : chat
        ));
      } else {
        const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(errorData.detail || 'Server error');
      }
    } catch {
      const errorMessage: Message = { 
        role: 'assistant', 
        content: 'An error occurred. Please make sure Ollama is running and Llama 3.1 is installed.' 
      };
      setChats(prev => prev.map(chat => 
        chat.id === activeChatId ? { ...chat, messages: [...updatedMessages, errorMessage] } : chat
      ));
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="flex h-screen w-full bg-[#131314] text-white font-sans selection:bg-[#015662] selection:text-white overflow-hidden">
      {/* Hidden file input always available in the DOM */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileUpload} 
        accept=".csv, .xlsx, .xls"
        className="hidden" 
      />

      {/* Sidebar */}
      <div className={`${isSidebarOpen ? 'w-72' : 'w-0'} bg-[#1e1f20] border-r border-white/5 flex flex-col transition-all duration-300 ease-in-out shrink-0 relative overflow-hidden`}>
        <div className="p-4 flex items-center justify-between min-w-[280px]">
          <h1 className="font-bold text-xl tracking-tight text-white flex items-center gap-2">
            <Database className="text-[#015662]" size={24} />
            Project
          </h1>
        </div>

        <div className="px-3 pb-4 min-w-[280px]">
          <button 
            onClick={handleNewChat}
            className="w-full flex items-center gap-2 bg-[#1a1a1a] hover:bg-[#2a2a2a] transition-all rounded-2xl px-4 py-3 text-sm font-medium text-white border border-white/10 group"
          >
            <Plus size={18} className="group-hover:rotate-90 transition-transform duration-300" />
            New Chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 space-y-1 min-w-[280px]">
          {chats.map(chat => (
            <div key={chat.id} className="relative group/item">
                {editingChatId === chat.id ? (
                  <div className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-[#015662]/20 border border-[#015662]/30">
                    <MessageSquare size={16} className="text-[#015662]" />
                    <input
                      autoFocus
                      onFocus={(e) => e.target.select()}
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onBlur={() => handleRename(chat.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(chat.id);
                        if (e.key === 'Escape') setEditingChatId(null);
                      }}
                      className="flex-1 bg-white/10 border-none rounded px-2 py-0.5 text-xs focus:outline-none text-white w-full"
                    />
                  </div>
                ) : (
                  <div
                    onClick={() => setActiveChatId(chat.id)}
                    className={`w-full cursor-pointer flex items-center gap-3 px-3 py-3 rounded-xl text-sm transition-all group ${
                      activeChatId === chat.id 
                        ? 'bg-[#015662]/20 text-white border border-[#015662]/30' 
                        : 'text-white/60 hover:bg-white/5 hover:text-white'
                    }`}
                  >
                    <MessageSquare size={16} className={activeChatId === chat.id ? 'text-[#015662]' : 'text-white/40'} />
                    <span className="flex-1 truncate text-left">{chat.name}</span>
                    
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(openMenuId === chat.id ? null : chat.id);
                      }}
                      className={`p-1 hover:bg-white/10 rounded-md transition-opacity ${activeChatId === chat.id ? 'opacity-100' : 'opacity-0 group-hover/item:opacity-100'}`}
                    >
                      <MoreVertical size={14} />
                    </button>
                  </div>
                )}

              {openMenuId === chat.id && (
                <div 
                  ref={menuRef}
                  className="absolute right-2 top-12 w-36 bg-[#2a2a2a] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden py-1"
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingChatId(chat.id);
                      setEditingName(chat.name);
                      setOpenMenuId(null);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white/80 hover:bg-white/5 transition-colors"
                  >
                    <Edit2 size={12} />
                    Rename Chat
                  </button>
                  <button
                    onClick={(e) => handleDeleteChat(chat.id, e)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors border-t border-white/5"
                  >
                    <Trash2 size={12} />
                    Delete Chat
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-white/5 min-w-[280px]">
          <div className="flex items-center gap-3 px-2 py-2 hover:bg-white/5 rounded-xl cursor-pointer text-sm text-white transition-colors group">
            <div className="w-8 h-8 rounded-full bg-[#015662] text-white flex items-center justify-center font-bold text-xs border border-white/10 group-hover:scale-105 transition-transform">
              <Database size={14} />
            </div>
            <div className="flex-1 truncate font-medium">User</div>
            <Settings size={16} className="text-white/40 group-hover:rotate-45 transition-transform" />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col relative h-full bg-[#131314]">
        {/* Sidebar Toggle Pill */}
        <button 
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] w-5 h-16 bg-[#1e1f20] border border-white/10 rounded-full flex flex-col items-center justify-center gap-1.5 hover:bg-[#2a2a2a] transition-all group shadow-2xl"
        >
          <div className="w-1 h-1 bg-white/20 rounded-full group-hover:bg-[#015662] transition-colors" />
          <div className="w-1 h-1 bg-white/20 rounded-full group-hover:bg-[#015662] transition-colors" />
          <div className="w-1 h-1 bg-white/20 rounded-full group-hover:bg-[#015662] transition-colors" />
        </button>

        {/* Header */}
        <div className="h-16 flex items-center justify-between px-6 border-b border-white/5 bg-[#131314]/80 backdrop-blur-md z-10">
          <div className="flex items-center gap-4">
            {activeChat && (
              <>
                <button 
                  onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                  className="p-2 hover:bg-white/5 rounded-lg transition-colors text-white/60 hover:text-white"
                >
                  <MessageSquare size={20} />
                </button>
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-white/90">
                    {activeChat.datasetName ? `Analyzing: ${activeChat.datasetName}` : 'No Dataset Loaded'}
                  </span>
                  {activeChat.datasetName && (
                    <span className="text-[10px] text-[#015662] font-bold uppercase tracking-widest">Active Session</span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
          {!activeChat ? (
            <div className="h-full flex flex-col items-center justify-center max-w-2xl mx-auto text-center space-y-6">
              <div className="w-20 h-20 bg-[#1e1f20] border border-white/5 rounded-3xl flex items-center justify-center shadow-2xl relative group">
                <div className="absolute inset-0 bg-[#015662]/20 blur-2xl rounded-full group-hover:bg-[#015662]/40 transition-all duration-500" />
                <span className="relative text-white font-bold text-3xl"></span>
              </div>
              <div className="space-y-2">
                <h2 className="text-3xl font-bold text-white tracking-tight">Welcome to Project</h2>
                <p className="text-white/50 text-lg">Click "New Chat" in the sidebar to start your data analysis journey.</p>
              </div>
            </div>
          ) : activeChat.messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center max-w-2xl mx-auto text-center space-y-6">
              <div className="w-20 h-20 bg-[#1e1f20] border border-white/5 rounded-3xl flex items-center justify-center shadow-2xl relative group">
                <div className="absolute inset-0 bg-[#015662]/20 blur-2xl rounded-full group-hover:bg-[#015662]/40 transition-all duration-500" />
                <span className="relative text-white font-bold text-3xl"></span>
              </div>
              <div className="space-y-2">
                <h2 className="text-3xl font-bold text-white tracking-tight">How can I help with your data?</h2>
                <p className="text-white/50 text-lg">Upload a CSV or Excel file to start asking questions.</p>
              </div>
              
              {!activeChat.datasetName && (
                <div className="w-full max-w-sm mt-8 flex flex-col gap-3">
                  <button 
                    onClick={() => { setUploadError(null); fileInputRef.current?.click(); }}
                    disabled={isUploading}
                    className="w-full group relative flex flex-col items-center justify-center p-8 border-2 border-dashed border-white/10 rounded-3xl hover:border-[#015662] hover:bg-[#015662]/5 transition-all cursor-pointer bg-[#1e1f20]/50 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isUploading ? (
                      <Loader2 className="h-8 w-8 text-[#015662] animate-spin mb-3" />
                    ) : (
                      <FileSpreadsheet className="h-8 w-8 text-white/40 group-hover:text-[#015662] mb-3 transition-colors" />
                    )}
                    <span className="text-sm font-semibold text-white/90">
                      {isUploading ? 'Yükleniyor...' : 'Veri Seti Yükle'}
                    </span>
                    <span className="text-xs text-white/40 mt-1">CSV, Excel (.xlsx, .xls) desteklenir</span>
                  </button>
                  {uploadError && (
                    <div className="w-full px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-2xl text-xs text-red-400 text-center leading-relaxed">
                      ⚠️ {uploadError}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="max-w-4xl mx-auto space-y-8">
              {activeChat.messages.map((msg, i) => (
                <div key={i} className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-4 rounded-3xl ${
                    msg.role === 'user' 
                      ? 'bg-[#015662] text-white rounded-tr-none' 
                      : 'bg-[#1e1f20] text-white/90 border border-white/5 rounded-tl-none'
                  }`}>
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              ))}
              {isTyping && (
                <div className="flex gap-4 justify-start">
                  <div className="bg-[#1e1f20] p-4 rounded-3xl rounded-tl-none border border-white/5">
                    <Loader2 className="h-4 w-4 text-[#015662] animate-spin" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Area */}
        {activeChat && (
          <div className="p-4 md:p-8 w-full max-w-5xl mx-auto">
            <div className={`relative flex items-end gap-2 bg-[#1e1f20] rounded-[32px] p-2 shadow-2xl border transition-all duration-300 ${
              !activeChat.datasetName 
                ? 'border-white/5 opacity-50' 
                : 'border-white/10 focus-within:border-[#015662] focus-within:ring-1 focus-within:ring-[#015662]'
            }`}>
              <button 
                disabled={!activeChat.datasetName}
                onClick={() => fileInputRef.current?.click()}
                className="p-4 text-white/40 hover:text-white transition-colors rounded-full hover:bg-white/5 disabled:cursor-not-allowed"
              >
                <Upload size={20} />
              </button>
              <textarea 
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                disabled={!activeChat.datasetName || isTyping}
                placeholder={activeChat.datasetName ? "Ask anything about your data..." : "Please upload a dataset to start chatting..."}
                className="flex-1 max-h-48 min-h-[56px] bg-transparent border-none focus:outline-none resize-none py-4 px-2 text-sm text-white placeholder:text-white/30 disabled:cursor-not-allowed"
                rows={1}
              />
              <button 
                onClick={handleSendMessage}
                disabled={!inputText.trim() || !activeChat.datasetName || isTyping}
                className="p-4 bg-[#015662] text-white rounded-full hover:bg-[#016b7a] transition-all shadow-lg border border-white/10 disabled:opacity-50 disabled:cursor-not-allowed group"
              >
                <Send size={20} className="group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
              </button>
            </div>
            <div className="text-center mt-4 text-[10px] text-white/20 uppercase tracking-widest font-bold">
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

