import React, { useState } from 'react';

const ConfirmEmail = ({ email, onConfirmationSuccess, onBackToLogin }) => {
  const [confirmationCode, setConfirmationCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const response = await fetch('/api/auth/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email,
          confirmationCode: confirmationCode
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setSuccess('Email confirmed successfully! Your account is now pending administrator approval. You will be notified when approved.');
        setTimeout(() => {
          onConfirmationSuccess();
        }, 4000); // Longer delay to show the message
      } else {
        setError(data.error || 'Confirmation failed');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const resendCode = async () => {
    try {
      // You could implement resend functionality here if needed
      setError('Please check your email for the confirmation code');
    } catch (err) {
      setError('Failed to resend code');
    }
  };

  return (
    <div className="auth-form-container">
      <div className="auth-form">
        <h2>Confirm Your Email</h2>
        <p className="text-muted mb-4">
          We sent a confirmation code to <strong>{email}</strong>. 
          Please enter the code below to activate your account.
        </p>
        <div className="alert alert-info">
          <i className="fas fa-info-circle me-2"></i>
          <strong>Note:</strong> After email confirmation, your account will need to be approved by an administrator before you can access the application.
        </div>
        
        {error && <div className="alert alert-danger">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}
        
        <form onSubmit={handleSubmit}>
          <div className="mb-3">
            <label className="form-label">Confirmation Code</label>
            <input
              type="text"
              className="form-control text-center"
              value={confirmationCode}
              onChange={(e) => setConfirmationCode(e.target.value)}
              placeholder="Enter 6-digit code"
              required
              autoFocus
              style={{ letterSpacing: '0.3em', fontSize: '1.2em' }}
            />
          </div>
          
          <button 
            type="submit" 
            className="btn btn-primary w-100 mb-3"
            disabled={loading || !confirmationCode}
          >
            {loading ? 'Confirming...' : 'Confirm Email'}
          </button>
        </form>
        
        <div className="auth-links">
          <button 
            type="button" 
            className="btn btn-link"
            onClick={resendCode}
          >
            Didn't receive the code? Check spam folder
          </button>
          <button 
            type="button" 
            className="btn btn-link"
            onClick={onBackToLogin}
          >
            Back to Login
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmEmail;