import React, { useState } from 'react';

const ResetPassword = ({ email, onResetSuccess, onBackToLogin }) => {
  const [formData, setFormData] = useState({
    confirmationCode: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    if (formData.newPassword !== formData.confirmPassword) {
      setError('Passwords do not match');
      setLoading(false);
      return;
    }

    if (formData.newPassword.length < 8) {
      setError('Password must be at least 8 characters long');
      setLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email,
          confirmationCode: formData.confirmationCode,
          newPassword: formData.newPassword
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setSuccess(data.message);
        setTimeout(() => {
          onResetSuccess();
        }, 2000);
      } else {
        setError(data.error || 'Password reset failed');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  return (
    <div className="auth-form-container">
      <div className="auth-form">
        <h2>Reset Password</h2>
        <p className="text-muted mb-4">
          Enter the code sent to <strong>{email}</strong> and your new password.
        </p>
        
        {error && <div className="alert alert-danger">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}
        
        <form onSubmit={handleSubmit}>
          <div className="mb-3">
            <label className="form-label">Reset Code</label>
            <input
              type="text"
              className="form-control text-center"
              name="confirmationCode"
              value={formData.confirmationCode}
              onChange={handleChange}
              placeholder="Enter 6-digit code"
              required
              autoFocus
              style={{ letterSpacing: '0.3em', fontSize: '1.1em' }}
            />
          </div>
          
          <div className="mb-3">
            <label className="form-label">New Password</label>
            <input
              type="password"
              className="form-control"
              name="newPassword"
              value={formData.newPassword}
              onChange={handleChange}
              required
              minLength="8"
            />
            <div className="form-text">
              Must be at least 8 characters with uppercase, lowercase, and numbers
            </div>
          </div>
          
          <div className="mb-3">
            <label className="form-label">Confirm New Password</label>
            <input
              type="password"
              className="form-control"
              name="confirmPassword"
              value={formData.confirmPassword}
              onChange={handleChange}
              required
            />
          </div>
          
          <button 
            type="submit" 
            className="btn btn-primary w-100 mb-3"
            disabled={loading || !formData.confirmationCode || !formData.newPassword || !formData.confirmPassword}
          >
            {loading ? 'Resetting...' : 'Reset Password'}
          </button>
        </form>
        
        <div className="auth-links">
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

export default ResetPassword;