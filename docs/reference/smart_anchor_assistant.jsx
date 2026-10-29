import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User as UserIcon, Loader2, AlertCircle, Info, ShieldCheck, Upload, FileText, Plus, LogOut, MessageSquare, Settings, Users, FileType2, Trash2, Layers, Sparkles, FileSignature, CheckSquare, Key, RefreshCw, Sidebar, PlusCircle, Edit3, X, Eye, Check, UserPlus, Moon, Sun, HelpCircle, Inbox, CornerDownRight, MessageSquareQuote, PenTool } from 'lucide-react';

// ==========================================
// [환경 설정 및 AI 모델 설정]
// ==========================================
// * 중요: 이 Canvas 가상 환경에서는 API 게이트웨이 보안 정책상 아래 'gemini-2.5-flash-preview-09-2025' 모델만 허용됩니다.
// * 배포 시 실제 사용하실 모델명으로 변경하여 사용하세요. (예: "gemini-3.1-flash-lite")
const ACTUAL_API_MODEL = "gemini-2.5-flash-preview-09-2025"; 

// 초기 시스템 기본 지침 1: 지침 전문 (내용 요약 및 발췌)
const DOC1_KNOWLEDGE = `RISE 사업비 집행 및 관리 지침 (개정) (2026. 3.)

1. 적용 범위 및 활용
- 광역지자체는 운영규정과 동 지침 범위 내에서 시도의 '사업비 집행 및 관리 기준' 수립.
- 글로컬대학 실행계획서 및 초광역 과제(COSS, SCOUT)는 동 지침과 자체 세부 기준만 적용 원칙.
- 사업비 중 국고보조금과 지자체 대응자금은 요건 충족 시 기업 등에 지원 가능(단, 기업은 인건비/간접비 편성 불가).

2. 사업비 관리
- 사업비는 대학본부 또는 산학협력단에서 총괄 관리 원칙 (별도 계정 설정).
- 글로컬대학, 의과대학, 초광역, 대학산학협력단지 사업비는 구분하여 별도 계정 운영.
- 원칙적으로 e나라도움 카드 및 계좌이체 사용. 유흥업소 등 제한업종 사용 불가.

3. 사업비 편성·집행 비율
- 총 사업비 규모에 따라 인건비 상한 차등 적용 (예: 10억원 이하 30% 이내, 200억원 초과 15% 이내).
- 그 밖의 사업운영 경비 5% 이내, 간접비 3% 이내.
- 보직수당/성과급은 합산하여 사업비 총액의 5% 범위, 연간 1인당 최대 1,000만원 한도.

4. 사업비 이월 및 정산
- 원칙적으로 이월 불가하나, 부득이한 경우 10% 이내에서 다음 사업연도로 1회 이월 가능.
- 사업 종료 또는 회계연도 종료 시 2개월 이내에 정산보고서 제출.

5. 항목별 사용 용도 (주요)
- 장학금: 학자금 보조 성격(참여 학생 대상). 생활비 보조 성격은 불가.
- 교육·연구 환경개선비: 토지 매입, 건물 신규 건축 불가 (예외 조건 있음).
- 실험·실습장비 및 기자재: 3천만원 이상은 자체 심의, 1억원 이상은 중앙센터 사전 승인. 종료 2개월 전까지 도입 완료.`;

// 초기 시스템 기본 지침 2: FAQ (내용 요약 및 발췌)
const DOC2_KNOWLEDGE = `RISE 사업비 집행 및 관리 관련 FAQ (2026.3.)

- Q: 기초지자체 대응자금 관리 방식?
  A: 지역RISE센터 교부·관리가 원칙. 제한 시 대학이 e나라도움에 자기부담금으로 입력.
- Q: 협의체 기업에 직접 지원 가능한가?
  A: 가능하나 지역RISE위원회 심의·의결 필요. 단, 인건비 및 간접비 편성 불가.
- Q: 사업연도(3월~익년2월)와 회계연도(1월~12월) 불일치 시 정산 시기?
  A: 12월 말 잔액을 회계연도 이월 후, 실질적으로 익년 2월 말일 기준 2개월 이내에 정산.
- Q: 사업비 선결제 가능한가?
  A: 불가. 원인행위 없이 지출 불가.
- Q: 부대시설(회의장 등) 사용 비용 집행 가능?
  A: 동일 사업자 운영 부대시설은 내부거래로 집행 불가. 별도 사업자 운영 시설은 가능.
- Q: 대학 내 단위과제 간 예산 변경?
  A: 가능 (단, 센터 사전 통지 필요). e나라도움 보조비목 신설/전용은 승인 필요.
- Q: 공무원 신분 국립대 교직원 수당 지급?
  A: 원칙적 불가. 단, 국립 글로컬대학은 지원금 5% 이내 인센티브 지급 예외 허용.
- Q: 보직수당 대상자?
  A: 사업단 등 전담조직 책임자 (사업단장 등).
- Q: 장비 3천만원 이상 구입?
  A: 자산등재 후 30일 이내 ZEUS에 필수 등록.
- Q: 사사문구 표기 방식?
  A: "본 과제(결과물)는 OOOO년도 교육부 및 OO시/도의 재원으로 OORISE센터의 지원을 받아 수행된 결과입니다."`;

const DEFAULT_PROMPT = `# 역할 및 페르소나
너는 [앵커 사업비 집행 및 관리 지침]에 대해 답변하는 전문 행정 어시스턴트이다. 상대방은 지역앵커센터 담당자, 대학 관계자이므로 항상 명확하고, 객관적이며, 신뢰할 수 있는 어조로 답변해야 한다.

# 핵심 목적
사용자의 질문에 대해 제공된 지침서 데이터(문서)를 기반으로 정확한 규정과 절차를 안내하는 것이다. 지침에 없는 내용을 임의로 가공하거나 추측하여 답변해서는 안 된다.

# 기본 원칙 및 제약 조건
1. 근거 중심 답변: 모든 답변은 반드시 업로드된 지침서 내용에 기반해야 한다. 가능한 경우 해당 규정의 위치(예: 업로드된 데이터 제목 및 OO페이지)를 함께 명시하라.
2. 환각(Hallucination) 방지: 지침서에 명시되지 않은 사항이거나 해석이 모호한 부분은 챗봇이 자의적으로 판단하지 말고, "해당 내용에 대해 명확한 답변들 드리기 어렵습니다. 정확한 확인을 위해 상위보조사업자(지역앵커센터, 주관대학 등) 또는 중앙앵커센터 담당자에게 문의하시기 바랍니다."라고 안내하라.
3. 예산 관련 주의: 집행 가능 항목/불가 항목(불인정 기준)에 대한 질문에는 예외 규정이나 증빙 서류 조건이 있는지 더 철저하게 확인하고 답변하라.
4. 마크다운 적용: 답변 작성 시 반드시 마크다운(Markdown) 문법(볼드체, 목록 등)을 적극적으로 적용하여 가독성을 높여라.

# 답변 구조 및 스타일
사용자가 정보를 직관적으로 파악할 수 있도록 다음과 같은 구조로 답변을 출력하라.

1. (질의요약) 사용자의 질문을 요약정리하여 제시
2. (답변요약) 질문에 대한 핵심 결론을 1~2줄로 요약해서 먼저 제시
3. (상세 안내) 구체적인 지침 내용 및 기준 (필요시 글머리 기호 사용)
  * 업로드한 표준 답변(안) 등 첨부자료를 종합적으로 분석하여 답변 제시
4. (관련 유의사항) 집행 시 주의해야 할 예외 조항
5. (근거 규정) 관련 지침서 제목과 조항 제시
  * 업로드한 표준 답변(안)은 공식적인 지침서가 아니므로 답변할때 제시하지 말 것 

"상기 답변은 주어진 질의내용에 따라 작성된 내용으로 추가적인 정보에 따라 적용기준이 달라 질 수 있습니다. 정확한 확인을 위해서는 상위보조사업자(지역앵커센터, 주관대학 등) 또는 중앙앵커센터 담당자에게 문의하시기 바랍니다." 라고 항상 말하며 마무리하라.`;

// 마크다운 파서 (텍스트 렌더링용)
const parseMarkdown = (text) => {
  if (!text) return '';
  let html = text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;') // XSS 방지
    .replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-indigo-700 dark:text-indigo-400">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
    .replace(/^### (.*$)/gim, '<h3 class="text-md font-bold mt-4 mb-1 text-slate-800 dark:text-slate-200">$1</h3>')
    .replace(/^## (.*$)/gim, '<h2 class="text-lg font-bold mt-5 mb-2 text-slate-800 dark:text-slate-200">$1</h2>')
    .replace(/^# (.*$)/gim, '<h1 class="text-xl font-bold mt-6 mb-2 text-slate-800 dark:text-slate-200">$1</h1>')
    .replace(/\n/g, '<br/>');
  return html;
};

// 지수 백오프를 적용한 API 호출 함수
const fetchWithRetry = async (url, options, retries = 5) => {
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (i === retries - 1) throw new Error(`서버 응답 오류 (상태 코드: ${response.status})`);
    } catch (e) {
      if (i === retries - 1) throw e;
    }
    await new Promise(resolve => setTimeout(resolve, delays[i]));
  }
};

export default function App() {
  // === 상태 관리 및 전역 제어 선언 ===
  const [isDarkMode, setIsDarkMode] = useState(false);
  
  // === 다크모드 전역 스타일 복구 (ReferenceError 해결책) ===
  const darkModeStyles = isDarkMode ? (
    <style>{`
      .dark { color-scheme: dark; }
      .dark.bg-white, .dark .bg-white { background-color: #1e293b !important; }
      .dark.bg-slate-50, .dark .bg-slate-50 { background-color: #0f172a !important; }
      .dark.bg-slate-100, .dark .bg-slate-100 { background-color: #020617 !important; }
      .dark .text-slate-800, .dark .text-slate-700 { color: #f8fafc !important; }
      .dark .text-slate-600, .dark .text-slate-500 { color: #cbd5e1 !important; }
      .dark .text-slate-400 { color: #94a3b8 !important; }
      .dark .border-slate-200, .dark .border-slate-300, .dark .border-slate-700 { border-color: #334155 !important; }
      .dark header.bg-slate-800 { background-color: #020617 !important; border-bottom: 1px solid #1e293b; }
      .dark.bg-slate-900, .dark .bg-slate-900 { background-color: #0f172a !important; border-right: 1px solid #334155; }
      .dark .bg-indigo-50 { background-color: #1e1b4b !important; border-color: #312e81 !important; }
      .dark .text-indigo-800, .dark .text-indigo-700 { color: #e0e7ff !important; }
      .dark .text-indigo-600 { color: #818cf8 !important; }
      .dark .border-indigo-100, .dark .border-indigo-200 { border-color: #3730a3 !important; }
      .dark .bg-indigo-100 { background-color: #312e81 !important; color: #c7d2fe !important; }
      .dark .bg-amber-50 { background-color: #422006 !important; }
      .dark .border-amber-200, .dark .border-amber-300 { border-color: #78350f !important; }
      .dark .text-amber-700, .dark .text-amber-800 { color: #fcd34d !important; }
      .dark .bg-amber-200 { background-color: #92400e !important; color: #fef3c7 !important; }
      .dark .bg-red-50 { background-color: #450a0a !important; }
      .dark .text-red-500, .dark .text-red-600, .dark .text-red-700 { color: #fca5a5 !important; }
      .dark .border-red-200 { border-color: #7f1d1d !important; }
      .dark .bg-red-100 { background-color: #7f1d1d !important; color: #fecaca !important; }
      .dark .bg-green-50 { background-color: #052e16 !important; }
      .dark .text-green-600, .dark .text-green-700 { color: #86efac !important; }
      .dark .border-green-200 { border-color: #14532d !important; }
      .dark input, .dark textarea, .dark select { background-color: #0f172a !important; color: #f8fafc !important; border-color: #334155 !important; }
      .dark input::placeholder, .dark textarea::placeholder { color: #64748b !important; }
    `}</style>
  ) : null;

  // React의 Rules of Hooks 준수를 위해 모든 State를 early return 전에 연속적으로 선언합니다.
  const [accounts, setAccounts] = useState([
    { id: 'admin', pw: 'admin', role: 'admin', name: '최고관리자', dept: '시스템운영팀', phone: '010-0000-0000', status: 'approved', failedAttempts: 0, isLocked: false, needsPasswordChange: false },
    { id: 'user01', pw: '1234', role: 'user', name: '일반사용자', dept: '산학협력단', phone: '010-1234-5678', status: 'approved', failedAttempts: 0, isLocked: false, needsPasswordChange: false }
  ]);
  const [currentUser, setCurrentUser] = useState(null);
  const [currentView, setCurrentView] = useState('chat'); // 'chat' | 'admin'

  const [isSignupMode, setIsSignupMode] = useState(false);
  const [signupData, setSignupData] = useState({ id: '', pw: '', name: '', dept: '', phone: '' });
  const [signupMsg, setSignupMsg] = useState('');

  const [chatSessions, setChatSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_PROMPT);
  const [editPrompt, setEditPrompt] = useState(DEFAULT_PROMPT);
  const [promptMsg, setPromptMsg] = useState('');

  const [showPwModal, setShowPwModal] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwMsg, setPwMsg] = useState('');

  const [forcePw, setForcePw] = useState('');
  const [forcePwConfirm, setForcePwConfirm] = useState('');
  const [forcePwMsg, setForcePwMsg] = useState('');

  const [adminMonitoringUser, setAdminMonitoringUser] = useState(null);
  const [adminSelectedSessionId, setAdminSelectedSessionId] = useState(null);
  const [accountMsg, setAccountMsg] = useState('');

  const [newUserId, setNewUserId] = useState('');
  const [newUserPw, setNewUserPw] = useState('');
  const [newUserRole, setNewUserRole] = useState('user');
  const [newUserName, setNewUserName] = useState('');
  const [newUserDept, setNewUserDept] = useState('');
  const [newUserPhone, setNewUserPhone] = useState('');

  const [documents, setDocuments] = useState([
    { id: 'doc1', name: '1. RISE 사업비 집행 및 관리 지침(2차 개정) 전문.txt', type: 'text', text: DOC1_KNOWLEDGE },
    { id: 'doc2', name: '2. RISE 사업비 집행 및 관리 지침(2차 개정) FAQ.txt', type: 'text', text: DOC2_KNOWLEDGE }
  ]);
  const [uploadMsg, setUploadMsg] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const fileInputRef = useRef(null);

  // 1:1 관리자 문의함 상태
  const [inquiries, setInquiries] = useState([
    { id: 'inq_sample', userId: 'user01', userName: '일반사용자', dept: '산학협력단', question: '연구수당 지급 시 증빙 서류는 어떤 것들이 필요한가요?', answer: null, status: 'pending', createdAt: new Date().toLocaleString(), answeredAt: null }
  ]);
  const [inquiryInput, setInquiryInput] = useState('');
  const [adminInquiryFilter, setAdminInquiryFilter] = useState('all'); // 'all' | 'pending' | 특정 userId
  const [replyingToId, setReplyingToId] = useState(null);
  const [replyInput, setReplyInput] = useState('');

  // 챗봇 상태
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  
  const messagesEndRef = useRef(null);

  // === 채팅 세션 헬퍼 ===
  const startNewChat = () => {
    const newId = Date.now().toString();
    setCurrentSessionId(newId);
    setMessages([{
      id: 'welcome',
      role: 'model',
      text: `안녕하세요! 스마트 앵커 어시스턴트입니다.\n등록된 다수의 지침 문서들을 교차 분석하여 가장 정확한 답변을 제공합니다.`
    }]);
  };

  const loadSession = (sessionId) => {
    const session = chatSessions.find(s => s.id === sessionId);
    if (session) {
      setCurrentSessionId(sessionId);
      setMessages(session.messages);
    }
  };

  const saveSession = (sessionId, currentMessages) => {
    setChatSessions(prev => {
      const existing = prev.find(s => s.id === sessionId);
      if (existing) {
        return prev.map(s => s.id === sessionId ? { ...s, messages: currentMessages } : s);
      } else {
        const title = currentMessages.length > 1 ? currentMessages[1].text.substring(0, 15) + '...' : '새로운 대화';
        return [{ id: sessionId, userId: currentUser.id, title, date: new Date().toLocaleDateString(), messages: currentMessages }, ...prev];
      }
    });
  };

  // === PDF.js 스크립트 로드 ===
  useEffect(() => {
    if (!window.pdfjsLib) {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js';
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
      };
      document.body.appendChild(script);
    }
  }, []);

  // 스크롤 이동
  useEffect(() => {
    if (currentView === 'chat') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading, currentView]);

  // === 로그인 및 회원가입 로직 ===
  const [loginId, setLoginId] = useState('');
  const [loginPw, setLoginPw] = useState('');
  const [loginError, setLoginError] = useState('');

  const handleLogin = (e) => {
    e.preventDefault();
    const userIdx = accounts.findIndex(acc => acc.id === loginId);
    
    if (userIdx === -1) {
      setLoginError('아이디 또는 비밀번호가 일치하지 않습니다.');
      return;
    }

    const user = accounts[userIdx];

    // 가입 승인 대기 상태 확인
    if (user.status === 'pending') {
      setLoginError('관리자의 승인을 대기 중인 계정입니다.');
      return;
    }

    // 잠금 확인
    if (user.role !== 'admin' && user.isLocked) {
      setLoginError('로그인 10회 실패로 계정이 일시 정지되었습니다. 관리자에게 문의하세요.');
      return;
    }

    // 비밀번호 불일치 (10회 실패 시 잠금)
    if (user.pw !== loginPw) {
      let updatedAccounts = [...accounts];
      if (user.role !== 'admin') {
        updatedAccounts[userIdx].failedAttempts = (updatedAccounts[userIdx].failedAttempts || 0) + 1;
        if (updatedAccounts[userIdx].failedAttempts >= 10) {
          updatedAccounts[userIdx].isLocked = true;
        }
        setAccounts(updatedAccounts);
        if (updatedAccounts[userIdx].isLocked) {
          setLoginError('비밀번호를 10회 틀려 계정이 보호 조치(잠금) 되었습니다.');
          return;
        }
      }
      setLoginError(`아이디 또는 비밀번호가 일치하지 않습니다. ${user.role !== 'admin' ? `(실패: ${updatedAccounts[userIdx].failedAttempts}/10)` : ''}`);
      return;
    }

    // 로그인 성공시 잠금 카운트 리셋
    let updatedAccounts = [...accounts];
    if (user.role !== 'admin') {
      updatedAccounts[userIdx].failedAttempts = 0;
      setAccounts(updatedAccounts);
    }

    // 세션 수립
    setCurrentUser({ ...user, failedAttempts: 0 });
    
    // 만약 비밀번호가 강제 초기화되어 변경해야 하는 상태가 아니라면 즉시 진입
    if (!user.needsPasswordChange) {
      setCurrentView(user.role === 'admin' ? 'admin' : 'chat');
    }
    
    setLoginError(''); setLoginId(''); setLoginPw('');

    // 기존 세션 로드 또는 새 채팅 시작
    const userSessions = chatSessions.filter(s => s.userId === user.id);
    if (userSessions.length > 0) {
      loadSession(userSessions[0].id);
    } else {
      startNewChat();
    }
  };

  const handleSignup = (e) => {
    e.preventDefault();
    if (!signupData.id || !signupData.pw || !signupData.name || !signupData.dept || !signupData.phone) {
      setSignupMsg('모든 필드(연락처 포함)를 입력해주세요.');
      return;
    }
    if (accounts.find(acc => acc.id === signupData.id)) {
      setSignupMsg('이미 존재하는 아이디입니다.');
      return;
    }

    const newAcc = { 
      id: signupData.id, 
      pw: signupData.pw, 
      role: 'user', 
      name: signupData.name, 
      dept: signupData.dept, 
      phone: signupData.phone,
      status: 'pending', // 회원가입 시 무조건 대기 상태
      failedAttempts: 0, 
      isLocked: false,
      needsPasswordChange: false
    };
    setAccounts([...accounts, newAcc]);
    setSignupMsg('가입 신청이 완료되었습니다! 관리자 승인 후 로그인할 수 있습니다.');
    setTimeout(() => {
      setSignupMsg('');
      setIsSignupMode(false);
      setSignupData({ id: '', pw: '', name: '', dept: '', phone: '' });
    }, 3000);
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setCurrentView('chat');
  };

  // === 비밀번호 변경 (본인 직접 변경용) ===
  const handleChangePassword = (e) => {
    e.preventDefault();
    if (pwCurrent !== currentUser.pw) {
      setPwMsg('현재 비밀번호가 일치하지 않습니다.');
      return;
    }
    if (!pwNew || pwNew.length < 4) {
      setPwMsg('새 비밀번호는 4자리 이상 입력해주세요.');
      return;
    }
    if (pwNew === currentUser.id) {
      setPwMsg('아이디와 동일한 비밀번호는 보안상 사용하실 수 없습니다.');
      return;
    }
    
    setAccounts(prev => prev.map(acc => 
      acc.id === currentUser.id ? { ...acc, pw: pwNew, needsPasswordChange: false } : acc
    ));
    setCurrentUser(prev => ({ ...prev, pw: pwNew, needsPasswordChange: false }));
    setPwMsg('비밀번호가 성공적으로 변경되었습니다.');
    setTimeout(() => {
      setShowPwModal(false);
      setPwMsg('');
      setPwCurrent('');
      setPwNew('');
    }, 1500);
  };

  // === 임시 비밀번호 로그인 시, 강제 비밀번호 변경 처리 ===
  const handleForcePasswordChange = (e) => {
    e.preventDefault();
    if (forcePw !== forcePwConfirm) {
      setForcePwMsg('새 비밀번호와 비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    if (forcePw.length < 4) {
      setForcePwMsg('비밀번호는 4자리 이상이어야 합니다.');
      return;
    }
    if (forcePw === currentUser.id) {
      setForcePwMsg('아이디를 그대로 사용할 수 없습니다. 보안상 다른 비밀번호로 바꾸어 주세요.');
      return;
    }

    // 1. 데이터 리스트 업데이트
    setAccounts(prev => prev.map(acc => 
      acc.id === currentUser.id ? { ...acc, pw: forcePw, needsPasswordChange: false } : acc
    ));

    // 2. 현재 로그인 유저 상태 업데이트 (needsPasswordChange 해제)
    setCurrentUser(prev => {
      const updated = { ...prev, pw: forcePw, needsPasswordChange: false };
      // 뷰 결정
      setCurrentView(updated.role === 'admin' ? 'admin' : 'chat');
      return updated;
    });

    // 3. 폼 클리어 및 초기화
    setForcePw('');
    setForcePwConfirm('');
    setForcePwMsg('');
  };

  // === 계정 관리 로직 (관리자 직접 추가 폼) ===
  const handleCreateAccount = (e) => {
    e.preventDefault();
    if (!newUserId || !newUserPw || !newUserName || !newUserDept || !newUserPhone) {
      setAccountMsg('모든 필드(연락처 포함)를 입력해주세요.');
      return;
    }
    if (accounts.find(acc => acc.id === newUserId)) {
      setAccountMsg('이미 존재하는 아이디입니다.');
      return;
    }

    const newAcc = { 
      id: newUserId, 
      pw: newUserPw, 
      role: newUserRole, 
      name: newUserName, 
      dept: newUserDept, 
      phone: newUserPhone,
      status: 'approved', // 관리자가 직접 만들면 즉시 승인 상태
      failedAttempts: 0, 
      isLocked: false,
      needsPasswordChange: false
    };
    setAccounts([...accounts, newAcc]);
    setAccountMsg(`'${newUserName}' 계정이 성공적으로 생성 및 승인되었습니다.`);
    setNewUserId(''); setNewUserPw(''); setNewUserName(''); setNewUserDept(''); setNewUserPhone(''); setNewUserRole('user');
    setTimeout(() => setAccountMsg(''), 3000);
  };

  // === 계정 관리 로직 (권한 및 상태 제어) ===
  const handleApproveAccount = (targetId) => {
    setAccounts(prev => prev.map(acc => 
      acc.id === targetId ? { ...acc, status: 'approved' } : acc
    ));
    setAccountMsg('계정이 승인되었습니다.');
    setTimeout(() => setAccountMsg(''), 3000);
  };

  const handleChangeRole = (targetId, newRole) => {
    if (targetId === 'admin') {
      setAccountMsg('기본 최고관리자 계정의 권한은 변경할 수 없습니다.');
      setTimeout(() => setAccountMsg(''), 3000);
      return;
    }
    if (targetId === currentUser.id) {
      setAccountMsg('현재 로그인 중인 계정의 권한은 직접 변경할 수 없습니다.');
      setTimeout(() => setAccountMsg(''), 3000);
      return;
    }
    setAccounts(prev => prev.map(acc => 
      acc.id === targetId ? { ...acc, role: newRole } : acc
    ));
    setAccountMsg(`계정 권한이 [${newRole === 'admin' ? '최고관리자' : '일반 사용자'}]로 변경되었습니다.`);
    setTimeout(() => setAccountMsg(''), 3000);
  };

  // === 비밀번호 초기화 시 ID를 패스워드로 설정 및 강제 변경 예약 설정 ===
  const handleResetPassword = (targetId) => {
    setAccounts(prev => prev.map(acc => 
      acc.id === targetId ? { ...acc, pw: acc.id, failedAttempts: 0, isLocked: false, needsPasswordChange: true } : acc
    ));
    setAccountMsg(`계정 비밀번호가 아이디('${targetId}')와 동일하게 초기화되었습니다. 대상 사용자는 다음 로그인 시 강제 비밀번호 변경 프로세스를 통과해야 합니다.`);
    setTimeout(() => setAccountMsg(''), 5000);
  };

  const handleDeleteAccount = (targetId) => {
    if (targetId === currentUser.id) {
      setAccountMsg('현재 로그인 중인 계정은 삭제할 수 없습니다.');
      setTimeout(() => setAccountMsg(''), 3000);
      return;
    }
    if (targetId === 'admin') {
      setAccountMsg('기본 최고관리자 계정은 삭제할 수 없습니다.');
      setTimeout(() => setAccountMsg(''), 3000);
      return;
    }
    
    setAccounts(prev => prev.filter(acc => acc.id !== targetId));
    setAccountMsg('계정이 성공적으로 삭제/거절되었습니다.');
    setTimeout(() => setAccountMsg(''), 3000);
  };

  // === 프롬프트 수정 저장 ===
  const handleSavePrompt = () => {
    setSystemPrompt(editPrompt);
    setPromptMsg('프롬프트가 성공적으로 적용되었습니다.');
    setTimeout(() => setPromptMsg(''), 3000);
  };

  // === 파일 다중 업로드 및 병렬 텍스트 추출 ===
  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    if (files.some(f => f.name.toLowerCase().endsWith('.pdf')) && !window.pdfjsLib) {
      setUploadMsg('PDF 리더가 준비되지 않았습니다. 잠시 후 시도해주세요.');
      return;
    }

    setIsExtracting(true);
    setUploadMsg('');
    const newDocs = [];
    let errorCount = 0;

    for (const file of files) {
      if (file.size > 15 * 1024 * 1024) {
        setUploadMsg(prev => prev + `\n[${file.name}] 15MB 초과로 제외됨.`);
        errorCount++;
        continue;
      }
      const extension = file.name.split('.').pop().toLowerCase();
      try {
        if (extension === 'pdf') {
          // Base64 변환
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });

          // 텍스트 추출 (미리보기용)
          let truncatedText = 'PDF 미리보기 생성 중 오류 발생';
          try {
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await window.pdfjsLib.getDocument(arrayBuffer).promise;
            let fullText = '';
            for (let i = 1; i <= pdf.numPages; i++) {
              const page = await pdf.getPage(i);
              const textContent = await page.getTextContent();
              fullText += textContent.items.map(item => item.str).join(' ') + '\n';
              if (fullText.length > 5000) break;
            }
            truncatedText = fullText.substring(0, 5000) + '\n\n...[미리보기 생략 (AI는 PDF 원본 자체를 분석하여 표와 서식을 읽습니다)]...';
          } catch(e) {
            console.warn('미리보기 텍스트 추출 실패', e);
          }

          newDocs.push({ id: Date.now().toString() + Math.random(), name: file.name, type: 'pdf', base64: base64, text: truncatedText });
          
        } else if (['txt', 'md', 'csv'].includes(extension)) {
          const text = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = ev => resolve(ev.target.result);
            reader.onerror = reject;
            reader.readAsText(file);
          });
          newDocs.push({ id: Date.now().toString() + Math.random(), name: file.name, type: 'text', text });
        } else {
          errorCount++;
        }
      } catch (err) {
        errorCount++;
      }
    }

    if (newDocs.length > 0) {
      setDocuments(prev => [...prev, ...newDocs]);
      setUploadMsg(`성공적으로 ${newDocs.length}개의 파일을 지식베이스에 추가했습니다. ${errorCount > 0 ? `(${errorCount}개 실패)` : ''}`);
    } else {
      setUploadMsg('파일 처리 중 오류가 발생했거나 지원하지 않는 형식입니다.');
    }

    setIsExtracting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setTimeout(() => setUploadMsg(''), 5000);
  };

  const handleRemoveDocument = (id) => {
    setDocuments(prev => prev.filter(doc => doc.id !== id));
  };

  const handleSummarizeDocument = async (id) => {
    setDocuments(prev => prev.map(doc => doc.id === id ? { ...doc, isSummarizing: true } : doc));
    try {
      const apiKey = ""; 
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${ACTUAL_API_MODEL}:generateContent?key=${apiKey}`;
      const doc = documents.find(d => d.id === id);
      
      const payload = {
        contents: [{
            role: 'user',
            parts: doc.type === 'pdf'
                ? [
                    { inlineData: { mimeType: "application/pdf", data: doc.base64 } },
                    { text: `다음 규정 문서의 핵심 내용을 3~4줄로 명확하게 요약해주세요.` }
                  ]
                : [
                    { text: `다음 규정 문서의 핵심 내용을 3~4줄로 명확하게 요약해주세요.\n\n${doc.text}` }
                  ]
        }]
      };

      const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      const summary = data.candidates?.[0]?.content?.parts?.[0]?.text || '요약을 생성하지 못했습니다.';

      setDocuments(prev => prev.map(doc => doc.id === id ? { ...doc, summary, isSummarizing: false } : doc));
    } catch (err) {
      setDocuments(prev => prev.map(doc => doc.id === id ? { ...doc, summary: '요약 중 오류가 발생했습니다.', isSummarizing: false } : doc));
    }
  };

  // === 챗봇 전송 ===
  const handleSendMessage = async (e) => {
    e?.preventDefault();
    if (!inputValue.trim()) return;

    const userMessage = { id: Date.now().toString(), role: 'user', text: inputValue.trim() };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    saveSession(currentSessionId, updatedMessages);
    
    setInputValue('');
    setIsLoading(true);
    setError('');

    try {
      const apiKey = ""; 
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${ACTUAL_API_MODEL}:generateContent?key=${apiKey}`;

      const pdfParts = documents
        .filter(d => d.type === 'pdf')
        .map(d => ({
          inlineData: { mimeType: "application/pdf", data: d.base64 }
        }));

      const chatHistory = updatedMessages
        .filter(msg => msg.id !== 'welcome')
        .map((msg, index) => {
          if (index === 0 && msg.role === 'user') {
             return {
                 role: 'user',
                 parts: [
                     ...pdfParts,
                     { text: `[안내: 첨부된 PDF 문서와 시스템 프롬프트의 텍스트 문서를 모두 교차 분석하여 질문에 답변하세요.]\n\n질문: ${msg.text}` }
                 ]
             };
          }
          return {
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.text }]
          };
        });

      const textDocsContext = documents.filter(doc => doc.type !== 'pdf').map((doc, idx) => `[문서 ${idx + 1}: ${doc.name}]\n${doc.text}`).join('\n\n====================\n\n');
      const finalSystemPrompt = `${systemPrompt}\n\n[텍스트 참고 문서 전체 목록 및 내용]\n${textDocsContext}`;

      const payload = {
        contents: chatHistory,
        systemInstruction: { parts: [{ text: finalSystemPrompt }] }
      };

      const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      const botReplyText = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!botReplyText) throw new Error('API 오류');

      const botMessage = { id: (Date.now() + 1).toString(), role: 'model', text: botReplyText };
      const finalMessages = [...updatedMessages, botMessage];
      
      setMessages(finalMessages);
      saveSession(currentSessionId, finalMessages);

    } catch (err) {
      setError('종합 판단을 수행하는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setIsLoading(false);
    }
  };

  // ==========================================
  // 렌더링 영역
  // ==========================================

  // --- 1단계: 비로그인 상태 화면 ---
  if (!currentUser) {
    return (
      <div className={`min-h-screen flex items-center justify-center p-4 transition-colors duration-300 ${isDarkMode ? 'dark bg-slate-900' : 'bg-slate-100'}`}>
        {darkModeStyles}
        <button type="button" onClick={() => setIsDarkMode(!isDarkMode)} className={`absolute top-4 right-4 p-2 rounded-full shadow-md transition ${isDarkMode ? 'bg-slate-800 text-yellow-400' : 'bg-white text-slate-600 hover:text-indigo-600'}`}>
          {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
        <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md">
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-indigo-600 rounded-full flex items-center justify-center mb-4 shadow-lg">
              <Layers className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">스마트 앵커 어시스턴트</h1>
            {isSignupMode && <p className="text-slate-500 text-sm mt-1">새로운 계정을 생성하세요</p>}
          </div>

          {!isSignupMode ? (
            // --- 로그인 폼 ---
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <input type="text" className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none" value={loginId} onChange={(e) => setLoginId(e.target.value)} placeholder="아이디" required />
              </div>
              <div>
                <input type="password" className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none" value={loginPw} onChange={(e) => setLoginPw(e.target.value)} placeholder="비밀번호" required />
              </div>
              {loginError && <p className="text-red-500 text-sm flex items-center"><AlertCircle className="w-4 h-4 mr-1" />{loginError}</p>}
              {signupMsg && !loginError && <p className="text-green-600 text-sm flex items-center"><ShieldCheck className="w-4 h-4 mr-1" />{signupMsg}</p>}
              
              <button type="submit" className="w-full bg-indigo-600 text-white font-bold py-3 rounded-lg hover:bg-indigo-700 transition shadow-md">로그인</button>
              
              <div className="text-center mt-4 pt-4 border-t border-slate-100">
                <span className="text-sm text-slate-500">계정이 없으신가요? </span>
                <button type="button" onClick={() => {setIsSignupMode(true); setLoginError(''); setSignupMsg('');}} className="text-sm text-indigo-600 font-bold hover:underline">가입 신청하기</button>
              </div>
            </form>
          ) : (
            // --- 회원가입 폼 ---
            <form onSubmit={handleSignup} className="space-y-3">
              <input type="text" className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none text-sm" value={signupData.id} onChange={(e) => setSignupData({...signupData, id: e.target.value})} placeholder="아이디" required />
              <input type="password" className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none text-sm" value={signupData.pw} onChange={(e) => setSignupData({...signupData, pw: e.target.value})} placeholder="비밀번호 (4자리 이상 권장)" required />
              <input type="text" className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none text-sm" value={signupData.name} onChange={(e) => setSignupData({...signupData, name: e.target.value})} placeholder="이름 (예: 홍길동)" required />
              <input type="text" className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none text-sm" value={signupData.dept} onChange={(e) => setSignupData({...signupData, dept: e.target.value})} placeholder="소속 (예: 산학협력단)" required />
              <input type="text" className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none text-sm" value={signupData.phone} onChange={(e) => setSignupData({...signupData, phone: e.target.value})} placeholder="연락처 (예: 010-1234-5678)" required />
              
              {signupMsg && <p className={`text-sm flex items-center ${signupMsg.includes('완료') ? 'text-green-600' : 'text-red-500'}`}><AlertCircle className="w-4 h-4 mr-1" />{signupMsg}</p>}
              
              <button type="submit" className="w-full bg-slate-800 text-white font-bold py-3 rounded-lg hover:bg-slate-900 transition shadow-md flex justify-center items-center mt-2">
                <UserPlus className="w-4 h-4 mr-2" /> 가입 신청
              </button>

              <div className="text-center mt-4">
                <button type="button" onClick={() => {setIsSignupMode(false); setSignupMsg('');}} className="text-sm text-slate-500 hover:text-slate-800 transition">로그인 화면으로 돌아가기</button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  // --- 2단계: 임시 비밀번호(아이디) 상태일 때 강제 변경 화면 ---
  if (currentUser && currentUser.needsPasswordChange) {
    return (
      <div className={`min-h-screen flex items-center justify-center p-4 transition-colors duration-300 ${isDarkMode ? 'dark bg-slate-900' : 'bg-slate-100'}`}>
        {darkModeStyles}
        <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md border border-amber-200">
          <div className="flex flex-col items-center mb-6">
            <div className="w-16 h-16 bg-amber-50 rounded-full flex items-center justify-center mb-4 border border-amber-200 shadow-sm">
              <Key className="w-8 h-8 text-amber-600 animate-bounce" />
            </div>
            <h1 className="text-xl font-bold text-slate-800">새로운 비밀번호 설정 필요</h1>
            <p className="text-slate-500 text-xs sm:text-sm mt-2 text-center leading-relaxed">
              관리자에 의해 비밀번호가 초기화되었습니다. <br />
              현재 임시 비밀번호(아이디) 상태입니다. <br />
              보안 강화를 위해 반드시 새로운 비밀번호를 설정해야 로그인이 완료됩니다.
            </p>
          </div>
          <form onSubmit={handleForcePasswordChange} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">새 비밀번호 (4자리 이상)</label>
              <input 
                type="password" 
                className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none text-sm bg-slate-50" 
                value={forcePw} 
                onChange={(e) => setForcePw(e.target.value)} 
                placeholder="새로운 고유 비밀번호를 입력하세요." 
                required 
                minLength={4}
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">새 비밀번호 확인</label>
              <input 
                type="password" 
                className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none text-sm bg-slate-50" 
                value={forcePwConfirm} 
                onChange={(e) => setForcePwConfirm(e.target.value)} 
                placeholder="비밀번호를 한번 더 입력해 주세요." 
                required 
                minLength={4}
              />
            </div>
            {forcePwMsg && <p className="text-red-500 text-xs flex items-center font-medium"><AlertCircle className="w-4 h-4 mr-1 shrink-0" />{forcePwMsg}</p>}
            
            <button type="submit" className="w-full bg-indigo-600 text-white font-bold py-3 rounded-lg hover:bg-indigo-700 transition shadow-md text-sm">
              비밀번호 설정 및 완료
            </button>
            
            <button 
              type="button" 
              onClick={handleLogout}
              className="w-full bg-slate-100 text-slate-600 font-bold py-2.5 rounded-lg hover:bg-slate-200 transition text-sm text-center block"
            >
              로그아웃 (취소)
            </button>
          </form>
        </div>
      </div>
    );
  }

  // 승인 대기중 / 승인 완료 명단 구성
  const pendingAccounts = accounts.filter(acc => acc.status === 'pending');
  const approvedAccounts = accounts.filter(acc => acc.status === 'approved');

  return (
    <div className={`flex flex-col h-screen max-h-screen font-sans transition-colors duration-300 ${isDarkMode ? 'dark bg-slate-900' : 'bg-slate-50'}`}>
      {darkModeStyles}
      {/* 헤더 */}
      <header className="bg-slate-800 text-white p-4 shadow-md flex items-center justify-between shrink-0 z-10 relative">
        <div className="flex items-center">
          <Layers className="w-7 h-7 mr-3 text-indigo-400" />
          <div>
            <h1 className="text-lg font-bold hidden sm:block">스마트 앵커 어시스턴트</h1>
            <h1 className="text-lg font-bold sm:hidden">스마트 앵커</h1>
          </div>
        </div>
        
        <div className="flex items-center space-x-4">
          <div className="flex bg-slate-700 p-1 rounded-lg">
            <button type="button" onClick={() => setCurrentView('chat')} className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-all ${currentView === 'chat' ? 'bg-indigo-600 text-white shadow' : 'text-slate-300 hover:text-white'}`}>
              <MessageSquare className="w-4 h-4 sm:mr-1.5" /> <span className="hidden sm:inline">챗봇</span>
            </button>
            
            {currentUser.role === 'admin' ? (
              <>
                <button type="button" onClick={() => { setCurrentView('inquiries'); setAdminInquiryFilter('all'); }} className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-all ${currentView === 'inquiries' ? 'bg-indigo-600 text-white shadow' : 'text-slate-300 hover:text-white'}`}>
                  <Inbox className="w-4 h-4 sm:mr-1.5" /> <span className="hidden sm:inline">문의 종합</span>
                  {inquiries.filter(i => i.status === 'pending').length > 0 && <span className="ml-1.5 bg-pink-500 text-white text-[10px] w-4 h-4 rounded-full flex items-center justify-center">{inquiries.filter(i => i.status === 'pending').length}</span>}
                </button>
                <button type="button" onClick={() => setCurrentView('admin')} className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-all ${currentView === 'admin' ? 'bg-indigo-600 text-white shadow' : 'text-slate-300 hover:text-white'}`}>
                  <Settings className="w-4 h-4 sm:mr-1.5" /> <span className="hidden sm:inline">데이터 관리</span>
                  {pendingAccounts.length > 0 && <span className="ml-1.5 bg-red-500 text-white text-[10px] w-4 h-4 rounded-full flex items-center justify-center">{pendingAccounts.length}</span>}
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setCurrentView('inquiries')} className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-all ${currentView === 'inquiries' ? 'bg-indigo-600 text-white shadow' : 'text-slate-300 hover:text-white'}`}>
                <HelpCircle className="w-4 h-4 sm:mr-1.5" /> <span className="hidden sm:inline">관리자 문의</span>
                {inquiries.filter(i => i.userId === currentUser.id && i.status === 'answered').length > 0 && <span className="ml-1.5 bg-green-500 text-white text-[10px] px-1.5 py-0.5 rounded-full flex items-center justify-center">답변완료</span>}
              </button>
            )}
          </div>
          <div className="h-6 w-px bg-slate-600 hidden sm:block"></div>
          <div className="flex items-center text-sm">
            <button type="button" onClick={() => setIsDarkMode(!isDarkMode)} className="flex items-center text-slate-300 hover:text-indigo-400 transition mr-4" title="다크모드 전환">
              {isDarkMode ? <Sun className="w-5 h-5 sm:w-4 sm:h-4 sm:mr-1" /> : <Moon className="w-5 h-5 sm:w-4 sm:h-4 sm:mr-1" />}
              <span className="hidden sm:inline">{isDarkMode ? '라이트모드' : '다크모드'}</span>
            </button>
            <span className="font-medium mr-4 hidden sm:inline"><UserIcon className="w-4 h-4 mr-1.5 text-slate-300 inline" />{currentUser.name}</span>
            <button type="button" onClick={() => setShowPwModal(true)} className="flex items-center text-slate-300 hover:text-indigo-400 transition mr-3" title="비밀번호 변경">
              <Key className="w-5 h-5 sm:w-4 sm:h-4 sm:mr-1" /> <span className="hidden sm:inline">비번변경</span>
            </button>
            <button type="button" onClick={handleLogout} className="flex items-center text-slate-300 hover:text-red-400 transition" title="로그아웃">
              <LogOut className="w-5 h-5 sm:w-4 sm:h-4 sm:mr-1" /> <span className="hidden sm:inline">로그아웃</span>
            </button>
          </div>
        </div>
      </header>

      {/* 비밀번호 변경 모달 */}
      {showPwModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
              <h3 className="font-bold text-slate-800 flex items-center"><Key className="w-4 h-4 mr-2" /> 비밀번호 변경</h3>
              <button type="button" onClick={() => {setShowPwModal(false); setPwMsg('');}} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleChangePassword} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">현재 비밀번호</label>
                <input type="password" value={pwCurrent} onChange={e => setPwCurrent(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-sm" required />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">새 비밀번호 (4자리 이상)</label>
                <input type="password" value={pwNew} onChange={e => setPwNew(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-sm" required minLength={4} />
              </div>
              {pwMsg && <p className={`text-sm font-medium ${pwMsg.includes('성공') ? 'text-green-600' : 'text-red-500'}`}>{pwMsg}</p>}
              <button type="submit" className="w-full bg-indigo-600 text-white py-2.5 rounded-lg text-sm font-bold hover:bg-indigo-700 transition">변경하기</button>
            </form>
          </div>
        </div>
      )}

      {/* 뷰 라우팅 */}
      {currentView === 'admin' ? (
        // ================= 관리자 화면 =================
        adminMonitoringUser ? (
          // ---- 1. 사용자 대화 모니터링 상세 뷰 (ChatGPT 스타일) ----
          <div className="flex-1 flex overflow-hidden bg-slate-100">
            {/* 모니터링 사이드바 */}
            <div className={`${isSidebarOpen ? 'w-64' : 'w-0'} bg-slate-900 text-white flex flex-col transition-all duration-300 shrink-0 overflow-hidden`}>
              <div className="p-4 flex items-center justify-between border-b border-slate-700 bg-slate-800/50">
                <span className="font-bold text-sm flex items-center"><MessageSquare className="w-4 h-4 mr-2" /> {adminMonitoringUser.name}의 대화</span>
                <button type="button" onClick={() => setAdminMonitoringUser(null)} className="text-slate-300 hover:text-white flex items-center text-xs transition" title="관리자 화면으로 돌아가기">
                  <X className="w-4 h-4 mr-1" /> 닫기
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-1.5 scrollbar-hide">
                {chatSessions.filter(s => s.userId === adminMonitoringUser.id).map(session => (
                  <button 
                    key={session.id}
                    type="button"
                    onClick={() => setAdminSelectedSessionId(session.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-sm truncate transition ${adminSelectedSessionId === session.id ? 'bg-indigo-600 text-white font-medium' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}
                  >
                    {session.title}
                  </button>
                ))}
                {chatSessions.filter(s => s.userId === adminMonitoringUser.id).length === 0 && (
                  <p className="text-xs text-slate-500 text-center mt-6">이전 대화가 없습니다.</p>
                )}
              </div>
            </div>

            {/* 모니터링 메인 채팅 영역 */}
            <div className="flex-1 flex flex-col bg-slate-50 overflow-hidden relative shadow-[-5px_0_15px_rgba(0,0,0,0.05)] z-0">
              <div className="bg-white border-b border-slate-200 p-3 flex flex-col sm:flex-row items-center shrink-0 text-xs sm:text-sm text-slate-800 absolute top-0 w-full z-10 shadow-sm">
                <button type="button" onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="absolute left-3 p-1 text-slate-500 hover:bg-slate-100 rounded mr-3 transition" title="대화 목록 열기/닫기">
                  <Sidebar className="w-5 h-5" />
                </button>
                <div className="flex items-center font-bold w-full justify-center pl-8 text-indigo-700">
                  <Eye className="w-4 h-4 mr-2 shrink-0" />
                  <span>[{adminMonitoringUser.name}] 사용자의 대화 기록 열람 중 (읽기 전용)</span>
                </div>
              </div>

              <main className="flex-1 overflow-y-auto p-4 pt-16 sm:pt-14 w-full max-w-4xl mx-auto flex flex-col gap-4">
                {adminSelectedSessionId ? (
                  chatSessions.find(s => s.id === adminSelectedSessionId)?.messages.map((msg) => (
                    <div key={msg.id} className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {msg.role === 'model' && <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center mr-2 shrink-0 mt-1 border border-indigo-200"><Bot className="w-5 h-5 text-indigo-600" /></div>}
                      
                      {msg.role === 'model' ? (
                        <div 
                          className="max-w-[85%] sm:max-w-[75%] p-4 rounded-2xl shadow-sm text-sm sm:text-base leading-relaxed bg-white text-slate-800 border border-slate-200 rounded-tl-sm dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700"
                          dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.text) }}
                        />
                      ) : (
                        <div className="max-w-[85%] sm:max-w-[75%] p-4 rounded-2xl shadow-sm text-sm sm:text-base leading-relaxed bg-slate-500 text-white rounded-tr-sm whitespace-pre-wrap">
                          {msg.text}
                        </div>
                      )}

                      {msg.role === 'user' && <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center ml-2 shrink-0 mt-1"><UserIcon className="w-5 h-5 text-slate-600" /></div>}
                    </div>
                  ))
                ) : (
                  <div className="flex-1 flex items-center justify-center text-slate-400">
                    좌측에서 열람할 대화를 선택해주세요.
                  </div>
                )}
              </main>
            </div>
          </div>
        ) : (
          // ---- 2. 기존 관리자 대시보드 ----
          <div className="flex-1 overflow-y-auto p-6 max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-2 gap-6">
            
            {/* 문서 업로드 카드 */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full max-h-[70vh]">
              <div className="p-5 border-b border-slate-200 bg-slate-50 shrink-0">
                <h2 className="text-lg font-bold text-slate-800 flex items-center"><FileText className="w-5 h-5 mr-2 text-indigo-600" /> 규정/지침 다중 업로드</h2>
              </div>
              <div className="p-6 flex-1 flex flex-col overflow-hidden">
                <div 
                  className={`border-2 border-dashed rounded-xl p-6 text-center transition cursor-pointer mb-4 shrink-0 relative overflow-hidden ${isExtracting ? 'border-indigo-400 bg-indigo-50 cursor-wait' : 'border-slate-300 hover:bg-slate-50'}`}
                  onClick={() => !isExtracting && fileInputRef.current?.click()}
                >
                  {isExtracting ? (
                    <div className="flex flex-col items-center">
                      <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                      <p className="text-sm font-bold text-indigo-700">문서 분석 및 병합 중...</p>
                    </div>
                  ) : (
                    <>
                      <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                      <p className="text-sm font-medium text-slate-700">여러 파일(.pdf, .txt)을 선택하거나 드래그하세요</p>
                    </>
                  )}
                  <input type="file" multiple accept=".txt,.pdf,.csv,.md" ref={fileInputRef} onChange={handleFileUpload} className="hidden" disabled={isExtracting} />
                </div>

                {uploadMsg && (
                  <div className={`px-4 py-3 rounded-lg flex items-center text-sm mb-4 shrink-0 ${uploadMsg.includes('오류') || uploadMsg.includes('실패') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
                    {uploadMsg.includes('오류') || uploadMsg.includes('실패') ? <AlertCircle className="w-4 h-4 mr-2 shrink-0" /> : <ShieldCheck className="w-4 h-4 mr-2 shrink-0" />}
                    {uploadMsg}
                  </div>
                )}

                <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 flex-1 flex flex-col overflow-hidden">
                  <div className="flex justify-between items-center mb-3 shrink-0">
                    <p className="text-xs font-bold text-slate-500 uppercase">학습된 문서 (총 {documents.length}개)</p>
                  </div>
                  <div className="overflow-y-auto flex-1 space-y-2 pr-1">
                    {documents.length === 0 ? <p className="text-sm text-slate-400 text-center py-4">학습된 문서가 없습니다.</p> : documents.map((doc, idx) => (
                      <div key={doc.id} className="bg-white border border-slate-200 rounded-lg p-3 flex flex-col group hover:border-indigo-300 transition">
                        <div className="flex justify-between items-start">
                          <div className="flex items-start overflow-hidden">
                            <FileType2 className="w-5 h-5 text-indigo-500 mr-2 shrink-0 mt-0.5" />
                            <div>
                              <p className="text-sm font-bold text-slate-700 truncate">{doc.name}</p>
                            </div>
                          </div>
                          <div className="flex items-center shrink-0 ml-2">
                            <button type="button" onClick={() => handleSummarizeDocument(doc.id)} disabled={doc.isSummarizing} className="text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-2 py-1 rounded text-xs font-medium flex items-center transition mr-2 disabled:opacity-50">
                              {doc.isSummarizing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="w-3 h-3 mr-1" />} AI 요약
                            </button>
                            <button type="button" onClick={() => handleRemoveDocument(doc.id)} className="text-slate-300 hover:text-red-500 p-1 rounded transition shrink-0"><Trash2 className="w-4 h-4" /></button>
                          </div>
                        </div>
                        {doc.summary && (
                          <div className="mt-3 bg-indigo-50/50 p-2.5 rounded border border-indigo-100/50 text-xs text-indigo-800">
                            <p className="font-semibold mb-1 flex items-center"><Sparkles className="w-3 h-3 mr-1" /> AI 요약본</p>
                            <p className="whitespace-pre-wrap leading-relaxed opacity-90">{doc.summary}</p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* 사용자 계정 관리 카드 (승인 및 권한 관리) */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col max-h-[70vh]">
              <div className="p-5 border-b border-slate-200 bg-slate-50 shrink-0 flex justify-between items-center">
                <h2 className="text-lg font-bold text-slate-800 flex items-center"><Users className="w-5 h-5 mr-2 text-indigo-600" /> 회원가입 승인 및 계정 관리</h2>
              </div>
              <div className="p-6 overflow-y-auto flex flex-col gap-6">
                
                {accountMsg && <p className="text-sm text-indigo-600 font-semibold bg-indigo-50 border border-indigo-200 p-3 rounded-lg">{accountMsg}</p>}

                {/* 승인 대기중인 계정 리스트 */}
                <div>
                  <p className="text-xs font-bold text-slate-500 mb-3 uppercase flex items-center">
                    가입 승인 대기 ({pendingAccounts.length}명)
                  </p>
                  <div className="space-y-2">
                    {pendingAccounts.length === 0 ? (
                      <p className="text-sm text-slate-400 bg-slate-50 p-4 rounded-lg border border-slate-200 text-center">승인 대기 중인 계정이 없습니다.</p>
                    ) : pendingAccounts.map((acc, idx) => (
                      <div key={idx} className="flex flex-col sm:flex-row justify-between items-start sm:items-center p-3 border border-amber-200 rounded-lg bg-amber-50 gap-3">
                        <div className="flex items-center">
                          <div className="w-8 h-8 rounded-full flex items-center justify-center mr-3 shrink-0 bg-amber-200 text-amber-700">
                            <UserPlus className="w-4 h-4" />
                          </div>
                          <div>
                            <p className="text-sm font-bold text-slate-800 flex items-center">
                              {acc.name} <span className="text-xs font-normal text-slate-500 ml-1">({acc.id})</span>
                            </p>
                            <p className="text-xs text-slate-600 mt-0.5">{acc.dept} | {acc.phone}</p>
                          </div>
                        </div>
                        <div className="flex items-center shrink-0 w-full sm:w-auto justify-end">
                          <select
                            value={acc.role}
                            onChange={(e) => handleChangeRole(acc.id, e.target.value)}
                            className="text-xs border border-amber-300 text-amber-800 rounded-md px-2 py-1.5 mr-2 bg-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                          >
                            <option value="user">일반 사용자</option>
                            <option value="admin">최고관리자</option>
                          </select>
                          <button type="button" onClick={() => handleApproveAccount(acc.id)} className="text-green-600 bg-white border border-green-200 hover:bg-green-600 hover:text-white px-3 py-1.5 rounded-lg text-xs font-bold transition mr-1" title="승인">
                            승인
                          </button>
                          <button type="button" onClick={() => handleDeleteAccount(acc.id)} className="text-red-600 bg-white border border-red-200 hover:bg-red-600 hover:text-white px-3 py-1.5 rounded-lg text-xs font-bold transition" title="거절 (삭제)">
                            거절
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="h-px bg-slate-200 w-full"></div>

                {/* 관리자 계정 직접 생성 폼 */}
                <div>
                  <p className="text-xs font-bold text-slate-500 mb-3 uppercase">관리자가 직접 계정 추가</p>
                  <form onSubmit={handleCreateAccount} className="space-y-4 bg-slate-50 p-5 rounded-xl border border-slate-200">
                    <div className="grid grid-cols-2 gap-4">
                      <div><label className="block text-xs font-bold text-slate-700 mb-1">아이디</label><input type="text" value={newUserId} onChange={e => setNewUserId(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-sm" placeholder="user02" /></div>
                      <div><label className="block text-xs font-bold text-slate-700 mb-1">비밀번호</label><input type="text" value={newUserPw} onChange={e => setNewUserPw(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-sm" placeholder="****" /></div>
                      <div><label className="block text-xs font-bold text-slate-700 mb-1">이름</label><input type="text" value={newUserName} onChange={e => setNewUserName(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-sm" placeholder="홍길동" /></div>
                      <div><label className="block text-xs font-bold text-slate-700 mb-1">소속</label><input type="text" value={newUserDept} onChange={e => setNewUserDept(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-sm" placeholder="산학협력단" /></div>
                      <div><label className="block text-xs font-bold text-slate-700 mb-1">연락처</label><input type="text" value={newUserPhone} onChange={e => setNewUserPhone(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-sm" placeholder="010-0000-0000" /></div>
                      <div>
                        <label className="block text-xs font-bold text-slate-700 mb-1">권한</label>
                        <select value={newUserRole} onChange={e => setNewUserRole(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-sm bg-white">
                          <option value="user">일반 사용자</option><option value="admin">최고관리자</option>
                        </select>
                      </div>
                    </div>
                    <button type="submit" className="w-full bg-indigo-600 text-white font-bold py-2.5 rounded-lg hover:bg-indigo-700 transition flex items-center justify-center text-sm"><Plus className="w-4 h-4 mr-1" /> 생성 및 즉시 승인</button>
                  </form>
                </div>

                <div className="h-px bg-slate-200 w-full"></div>

                {/* 등록된 (승인된) 계정 리스트 */}
                <div>
                  <p className="text-xs font-bold text-slate-500 mb-3 uppercase">등록된 계정 목록 (총 {approvedAccounts.length}명)</p>
                  <div className="space-y-2">
                    {approvedAccounts.map((acc, idx) => {
                      const pendingInquiriesCount = inquiries.filter(i => i.userId === acc.id && i.status === 'pending').length;
                      const isHighlighted = pendingInquiriesCount > 0;
                      
                      return (
                      <div key={idx} className={`flex flex-col sm:flex-row justify-between items-start sm:items-center p-3 border rounded-lg transition gap-3 ${isHighlighted ? 'border-pink-300 bg-pink-50 hover:border-pink-400' : 'border-slate-200 bg-white hover:border-indigo-300'}`}>
                        <div className="flex items-center">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center mr-3 shrink-0 ${acc.role === 'admin' ? 'bg-red-100 text-red-600' : isHighlighted ? 'bg-pink-200 text-pink-700' : 'bg-blue-100 text-blue-600'}`}>
                            {acc.role === 'admin' ? <ShieldCheck className="w-4 h-4" /> : <UserIcon className="w-4 h-4" />}
                          </div>
                          <div>
                            <p className="text-sm font-bold text-slate-800 flex items-center">
                              {acc.name} <span className="text-xs font-normal text-slate-500 ml-1">({acc.id})</span>
                              {acc.isLocked && <span className="ml-2 bg-red-100 text-red-600 text-[10px] px-1.5 py-0.5 rounded font-bold">잠김</span>}
                              {acc.needsPasswordChange && <span className="ml-2 bg-amber-100 text-amber-700 text-[10px] px-1.5 py-0.5 rounded font-bold" title="임시 비밀번호 상태 (다음 로그인 시 변경 강제됨)">변경 대기</span>}
                              {isHighlighted && <span className="ml-2 bg-pink-500 text-white text-[10px] px-1.5 py-0.5 rounded font-bold shadow-sm animate-pulse">문의 대기 {pendingInquiriesCount}건</span>}
                            </p>
                            <p className="text-xs text-slate-500 mt-0.5">{acc.dept} | {acc.phone}</p>
                          </div>
                        </div>
                        <div className="flex items-center shrink-0 w-full sm:w-auto justify-end">
                          <select
                            value={acc.role}
                            onChange={(e) => handleChangeRole(acc.id, e.target.value)}
                            disabled={acc.id === 'admin' || acc.id === currentUser.id}
                            className={`text-xs border rounded-md px-2 py-1.5 mr-2 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 disabled:bg-transparent disabled:border-transparent cursor-pointer ${isHighlighted ? 'border-pink-200 bg-pink-50 text-pink-800' : 'border-slate-200 bg-slate-50 text-slate-700'}`}
                          >
                            <option value="user">일반 사용자</option>
                            <option value="admin">최고관리자</option>
                          </select>
                          
                          {acc.role !== 'admin' && isHighlighted && (
                            <button 
                              type="button"
                              onClick={() => {
                                setAdminInquiryFilter(acc.id);
                                setCurrentView('inquiries');
                              }} 
                              className="text-pink-600 hover:text-white hover:bg-pink-600 border border-pink-200 bg-white px-2 py-1.5 text-xs font-bold rounded transition shadow-sm mr-1" 
                              title="이 사용자의 문의함 열기"
                            >
                              질의응답 확인
                            </button>
                          )}

                          {acc.role !== 'admin' && (
                            <button 
                              type="button"
                              onClick={() => {
                                setAdminMonitoringUser(acc);
                                const userSessions = chatSessions.filter(s => s.userId === acc.id);
                                if(userSessions.length > 0) setAdminSelectedSessionId(userSessions[0].id);
                                else setAdminSelectedSessionId(null);
                              }} 
                              className="text-slate-400 hover:text-indigo-600 p-1.5 rounded transition" 
                              title="대화 기록 열람"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                          )}
                          <button type="button" onClick={() => handleResetPassword(acc.id)} className="text-slate-400 hover:text-amber-500 p-1.5 rounded transition ml-1" title="비밀번호를 아이디로 초기화하고 다음번에 강제 변경하도록 지정">
                            <RefreshCw className="w-4 h-4" />
                          </button>
                          <button type="button" onClick={() => handleDeleteAccount(acc.id)} className="text-slate-400 hover:text-red-500 p-1.5 rounded transition ml-1" title="계정 삭제">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );})}
                  </div>
                </div>
                
              </div>
            </div>

            {/* 프롬프트 관리 카드 */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col max-h-[70vh] md:col-span-1 lg:col-span-2">
              <div className="p-5 border-b border-slate-200 bg-slate-50 shrink-0">
                <h2 className="text-lg font-bold text-slate-800 flex items-center"><Edit3 className="w-5 h-5 mr-2 text-indigo-600" /> 시스템 프롬프트 관리</h2>
                <p className="text-sm text-slate-500 mt-1">챗봇이 답변을 생성할 때 기본적으로 따르는 성격과 행동 지침입니다.</p>
              </div>
              <div className="p-6 flex-1 flex flex-col">
                <textarea
                  value={editPrompt}
                  onChange={e => setEditPrompt(e.target.value)}
                  className="w-full h-40 p-4 bg-slate-50 border border-slate-300 rounded-xl font-mono text-sm leading-relaxed text-slate-700 resize-none focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
                <div className="flex items-center justify-between mt-3 shrink-0">
                  <p className={`text-sm font-medium ${promptMsg ? 'text-green-600' : 'text-transparent'}`}>{promptMsg || ' '}</p>
                  <button type="button" onClick={handleSavePrompt} className="px-5 py-2.5 bg-slate-800 text-white rounded-lg text-sm font-bold hover:bg-slate-900 transition shadow-sm">프롬프트 적용</button>
                </div>
              </div>
            </div>
          </div>
        )
      ) : currentView === 'inquiries' ? (
        // ================= 1:1 문의 / 종합 페이지 =================
        <div className="flex-1 overflow-y-auto p-6 max-w-5xl mx-auto w-full flex flex-col gap-6">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col overflow-hidden">
            <div className="p-5 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
              <div>
                <h2 className="text-lg font-bold text-slate-800 flex items-center">
                  {currentUser.role === 'admin' ? <Inbox className="w-5 h-5 mr-2 text-indigo-600" /> : <HelpCircle className="w-5 h-5 mr-2 text-indigo-600" />}
                  {currentUser.role === 'admin' ? '관리자 1:1 문의 종합함' : '관리자에게 1:1 문의하기'}
                </h2>
                <p className="text-sm text-slate-500 mt-1">
                  {currentUser.role === 'admin' ? '일반 사용자들이 남긴 문의를 확인하고 답변을 작성할 수 있습니다.' : '챗봇으로 해결되지 않는 복잡한 지침 문의나 시스템 오류를 관리자에게 남겨주세요.'}
                </p>
              </div>
              {currentUser.role === 'admin' && adminInquiryFilter !== 'all' && (
                <button type="button" onClick={() => setAdminInquiryFilter('all')} className="px-4 py-2 bg-indigo-100 text-indigo-700 rounded-lg text-sm font-bold hover:bg-indigo-200 transition">
                  전체 목록 보기
                </button>
              )}
            </div>

            <div className="p-6 bg-slate-50 flex-1">
              {currentUser.role === 'user' && (
                <form onSubmit={(e) => {
                  e.preventDefault();
                  if(!inquiryInput.trim()) return;
                  setInquiries([{ id: Date.now().toString(), userId: currentUser.id, userName: currentUser.name, dept: currentUser.dept, question: inquiryInput.trim(), answer: null, status: 'pending', createdAt: new Date().toLocaleString(), answeredAt: null }, ...inquiries]);
                  setInquiryInput('');
                }} className="mb-8 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                  <label className="block text-sm font-bold text-slate-700 mb-2">새로운 문의 작성</label>
                  <textarea value={inquiryInput} onChange={e => setInquiryInput(e.target.value)} className="w-full h-24 p-3 bg-slate-50 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-indigo-500 focus:outline-none mb-3" placeholder="궁금한 사항을 상세히 남겨주시면 관리자가 확인 후 답변해 드립니다." required />
                  <div className="flex justify-end">
                    <button type="submit" className="px-6 py-2.5 bg-slate-800 text-white rounded-lg text-sm font-bold hover:bg-slate-900 transition flex items-center shadow-sm">
                      <Send className="w-4 h-4 mr-2" /> 문의 등록
                    </button>
                  </div>
                </form>
              )}

              <div className="space-y-4">
                <h3 className="text-sm font-bold text-slate-700 uppercase mb-4">
                  {currentUser.role === 'admin' ? (adminInquiryFilter === 'all' ? '전체 문의 내역' : adminInquiryFilter === 'pending' ? '미답변 문의 내역' : '특정 사용자 문의 내역') : '나의 문의 내역'}
                </h3>
                
                {inquiries.filter(i => currentUser.role === 'user' ? i.userId === currentUser.id : (adminInquiryFilter === 'all' ? true : adminInquiryFilter === 'pending' ? i.status === 'pending' : i.userId === adminInquiryFilter)).length === 0 ? (
                  <div className="text-center py-10 bg-white border border-slate-200 rounded-xl">
                    <MessageSquareQuote className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                    <p className="text-slate-500 text-sm">해당하는 문의 내역이 없습니다.</p>
                  </div>
                ) : inquiries.filter(i => currentUser.role === 'user' ? i.userId === currentUser.id : (adminInquiryFilter === 'all' ? true : adminInquiryFilter === 'pending' ? i.status === 'pending' : i.userId === adminInquiryFilter)).map((inq) => (
                  <div key={inq.id} className={`bg-white border rounded-xl overflow-hidden shadow-sm transition ${inq.status === 'pending' ? 'border-amber-200' : 'border-slate-200'}`}>
                    <div className={`p-4 flex items-start justify-between border-b ${inq.status === 'pending' ? 'bg-amber-50/50 border-amber-100' : 'bg-slate-50 border-slate-100'}`}>
                      <div className="flex items-start gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${inq.status === 'pending' ? 'bg-amber-100 text-amber-600' : 'bg-slate-200 text-slate-600'}`}>
                          <HelpCircle className="w-5 h-5" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-bold text-slate-800 text-sm">{inq.userName}</span>
                            <span className="text-xs text-slate-500">({inq.dept} / {inq.userId})</span>
                            <span className="text-xs text-slate-400 ml-2">{inq.createdAt}</span>
                          </div>
                          <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{inq.question}</p>
                        </div>
                      </div>
                      <div className="shrink-0 ml-4">
                        {inq.status === 'pending' ? (
                          <span className="px-2.5 py-1 bg-amber-100 text-amber-700 text-xs font-bold rounded-full border border-amber-200">답변 대기</span>
                        ) : (
                          <span className="px-2.5 py-1 bg-green-100 text-green-700 text-xs font-bold rounded-full border border-green-200">답변 완료</span>
                        )}
                      </div>
                    </div>
                    
                    {/* 답변 영역 */}
                    {inq.status === 'answered' && (
                      <div className="p-4 bg-white flex items-start gap-3 pl-5">
                        <CornerDownRight className="w-5 h-5 text-indigo-400 shrink-0 mt-1" />
                        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
                          <ShieldCheck className="w-5 h-5 text-indigo-600" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-bold text-indigo-800 text-sm">관리자 답변</span>
                            <span className="text-xs text-slate-400">{inq.answeredAt}</span>
                          </div>
                          <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{inq.answer}</p>
                        </div>
                      </div>
                    )}

                    {/* 관리자: 미답변 항목에 대한 답변 작성 폼 */}
                    {currentUser.role === 'admin' && inq.status === 'pending' && (
                      <div className="p-4 bg-white border-t border-amber-100">
                        {replyingToId === inq.id ? (
                          <div className="flex flex-col gap-3">
                            <textarea autoFocus value={replyInput} onChange={e => setReplyInput(e.target.value)} className="w-full h-24 p-3 bg-slate-50 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-indigo-500 focus:outline-none" placeholder="답변을 작성해주세요." />
                            <div className="flex justify-end gap-2">
                              <button type="button" onClick={() => {setReplyingToId(null); setReplyInput('');}} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg text-sm font-bold hover:bg-slate-200 transition">취소</button>
                              <button type="button" onClick={() => {
                                if(!replyInput.trim()) return;
                                setInquiries(prev => prev.map(item => item.id === inq.id ? { ...item, answer: replyInput.trim(), status: 'answered', answeredAt: new Date().toLocaleString() } : item));
                                setReplyingToId(null);
                                setReplyInput('');
                              }} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-bold hover:bg-indigo-700 transition flex items-center shadow-sm">
                                <PenTool className="w-4 h-4 mr-1.5" /> 답변 등록
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button type="button" onClick={() => setReplyingToId(inq.id)} className="w-full py-2.5 bg-slate-50 border border-slate-200 border-dashed rounded-lg text-sm font-bold text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 hover:border-indigo-200 transition flex items-center justify-center">
                            <Edit3 className="w-4 h-4 mr-1.5" /> 이 문의에 답변하기
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        // ================= 챗봇 화면 (사이드바 + 메인) =================
        <div className="flex-1 flex overflow-hidden bg-slate-100">
          
          {/* 채팅 기록 사이드바 */}
          <div className={`${isSidebarOpen ? 'w-64' : 'w-0'} bg-slate-900 text-white flex flex-col transition-all duration-300 shrink-0 overflow-hidden`}>
            <div className="p-4 flex items-center justify-between border-b border-slate-700 bg-slate-800/50">
              <span className="font-bold text-sm flex items-center"><MessageSquare className="w-4 h-4 mr-2" /> 대화 목록</span>
              <button type="button" onClick={startNewChat} className="text-slate-300 hover:text-white transition" title="새 대화 시작"><PlusCircle className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5 scrollbar-hide">
              {chatSessions.filter(s => s.userId === currentUser.id).map(session => (
                <button 
                  key={session.id}
                  type="button"
                  onClick={() => loadSession(session.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm truncate transition ${currentSessionId === session.id ? 'bg-indigo-600 text-white font-medium' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}
                >
                  {session.title}
                </button>
              ))}
              {chatSessions.filter(s => s.userId === currentUser.id).length === 0 && (
                <p className="text-xs text-slate-500 text-center mt-6">이전 대화가 없습니다.</p>
              )}
            </div>
          </div>

          {/* 채팅 메인 영역 */}
          <div className="flex-1 flex flex-col bg-white overflow-hidden relative shadow-[-5px_0_15px_rgba(0,0,0,0.05)] z-0">
            <div className="bg-indigo-50 border-b border-indigo-100 p-3 flex flex-col sm:flex-row items-center shrink-0 text-xs sm:text-sm text-indigo-800 absolute top-0 w-full z-10 shadow-sm">
              <button type="button" onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="absolute left-3 p-1 text-indigo-600 hover:bg-indigo-100 rounded mr-3 transition" title="대화 목록 열기/닫기">
                <Sidebar className="w-5 h-5" />
              </button>
              <div className="flex items-center font-semibold w-full justify-center pl-8 text-center">
                <Layers className="w-4 h-4 mr-2 shrink-0 text-indigo-600" />
                <span>교차 검증 모드 동작 중</span>
              </div>
            </div>

            <main className="flex-1 overflow-y-auto p-4 pt-16 sm:pt-14 w-full max-w-4xl mx-auto flex flex-col gap-4">
              {messages.map((msg) => (
                <div key={msg.id} className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'model' && <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center mr-2 shrink-0 mt-1 border border-indigo-200"><Bot className="w-5 h-5 text-indigo-600" /></div>}
                  
                  {msg.role === 'model' ? (
                    <div 
                      className="max-w-[85%] sm:max-w-[75%] p-4 rounded-2xl shadow-sm text-sm sm:text-base leading-relaxed bg-white text-slate-800 border border-slate-200 rounded-tl-sm dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700"
                      dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.text) }}
                    />
                  ) : (
                    <div className="max-w-[85%] sm:max-w-[75%] p-4 rounded-2xl shadow-sm text-sm sm:text-base leading-relaxed bg-slate-800 text-white rounded-tr-sm whitespace-pre-wrap">
                      {msg.text}
                    </div>
                  )}

                  {msg.role === 'user' && <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center ml-2 shrink-0 mt-1"><UserIcon className="w-5 h-5 text-slate-600" /></div>}
                </div>
              ))}
              {isLoading && (
                <div className="flex w-full justify-start">
                  <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center mr-2 shrink-0"><Bot className="w-5 h-5 text-indigo-600" /></div>
                  <div className="bg-white border border-slate-200 p-4 rounded-2xl rounded-tl-sm shadow-sm flex items-center space-x-2"><Loader2 className="w-5 h-5 text-indigo-500 animate-spin" /><span className="text-slate-500 text-sm">분석 엔진 가동 중...</span></div>
                </div>
              )}
              {error && <div className="flex w-full justify-center my-2"><div className="bg-red-50 text-red-600 px-4 py-2 rounded-lg flex items-center text-sm border border-red-200"><AlertCircle className="w-4 h-4 mr-2" />{error}</div></div>}
              <div ref={messagesEndRef} className="h-4" />
            </main>

            <footer className="bg-white p-4 border-t border-slate-200 shrink-0 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
              <div className="max-w-4xl mx-auto flex flex-col gap-2">
                <div className="flex items-end gap-2">
                  <textarea className="flex-1 max-h-32 min-h-[52px] p-3.5 bg-slate-50 border border-slate-300 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-shadow text-slate-800" placeholder="질문을 입력해 주세요. (Shift + Enter로 줄바꿈)" value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }} disabled={isLoading} rows={1} />
                  <button type="button" onClick={handleSendMessage} disabled={!inputValue.trim() || isLoading} className={`p-3.5 rounded-xl flex items-center justify-center transition-colors shrink-0 ${!inputValue.trim() || isLoading ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-md'}`}><Send className="w-6 h-6" /></button>
                </div>
              </div>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}