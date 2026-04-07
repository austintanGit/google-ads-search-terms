import React, { useState } from 'react';
import Login from './Login';
import Register from './Register';
import ConfirmEmail from './ConfirmEmail';
import ForgotPassword from './ForgotPassword';
import ResetPassword from './ResetPassword';

const AuthPage = () => {
  const [currentView, setCurrentView] = useState('login'); // 'login', 'register', 'confirm', 'forgot', 'reset'
  const [registrationEmail, setRegistrationEmail] = useState('');
  const [resetEmail, setResetEmail] = useState('');

  const handleSwitchToRegister = () => {
    setCurrentView('register');
  };

  const handleSwitchToLogin = () => {
    setCurrentView('login');
  };

  const handleRegistrationSuccess = (email, message) => {
    setRegistrationEmail(email);
    setCurrentView('confirm');
  };

  const handleConfirmationSuccess = () => {
    setCurrentView('login');
  };

  const handleForgotPassword = () => {
    setCurrentView('forgot');
  };

  const handleResetCodeSent = (email) => {
    setResetEmail(email);
    setCurrentView('reset');
  };

  const handleResetSuccess = () => {
    setCurrentView('login');
  };

  return (
    <div className="auth-page">
      <div className="auth-background">
        <div className="auth-container">
          {/* Logo/Header */}
          <div className="auth-header text-center mb-4">
            <img 
              src="/assets/logo.png" 
              alt="Google Ads Tools" 
              style={{ height: '60px', marginBottom: '20px' }}
            />
            <h1>Google Ads Search Terms Tool</h1>
            <p className="text-muted">Manage your negative keywords with AI assistance</p>
          </div>

          {/* Authentication Forms */}
          {currentView === 'login' && (
            <Login 
              onSwitchToRegister={handleSwitchToRegister}
              onForgotPassword={handleForgotPassword}
            />
          )}

          {currentView === 'register' && (
            <Register 
              onSwitchToLogin={handleSwitchToLogin}
              onRegistrationSuccess={handleRegistrationSuccess}
            />
          )}

          {currentView === 'confirm' && (
            <ConfirmEmail 
              email={registrationEmail}
              onConfirmationSuccess={handleConfirmationSuccess}
              onBackToLogin={handleSwitchToLogin}
            />
          )}

          {currentView === 'forgot' && (
            <ForgotPassword 
              onBackToLogin={handleSwitchToLogin}
              onResetCodeSent={handleResetCodeSent}
            />
          )}

          {currentView === 'reset' && (
            <ResetPassword 
              email={resetEmail}
              onResetSuccess={handleResetSuccess}
              onBackToLogin={handleSwitchToLogin}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default AuthPage;