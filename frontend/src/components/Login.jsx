import React, { useState } from 'react';

const Login = ({ onSwitchToRegister, onForgotPassword }) => {
  const [formData, setFormData] = useState({
    email: '',
    password: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [errorType, setErrorType] = useState('danger'); // 'danger', 'warning', 'info'

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setErrorType('danger');

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData),
      });

      const data = await response.json();

      if (response.ok) {
        // Store token and user info
        localStorage.setItem('authToken', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        
        // Reload the page to trigger app refresh
        window.location.reload();
      } else {
        const errorMessage = data.details || data.error || 'Login failed';
        
        // Check if it's an approval-related error and provide helpful guidance
        if (errorMessage.toLowerCase().includes('pending approval')) {
          setErrorType('warning');
          setError(
            '⏳ Your account is pending administrator approval. Please wait for an administrator to review and approve your access. You will receive an email notification when approved.'
          );
        } else if (errorMessage.toLowerCase().includes('rejected')) {
          setErrorType('danger');
          setError(
            '❌ Your account has been rejected by an administrator. Please contact support for more information.'
          );
        } else {
          setErrorType('danger');
          setError(errorMessage);
        }
      }
    } catch (err) {
      setErrorType('danger');
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
        <h2>Sign In</h2>
        
        {error && <div className={`alert alert-${errorType}`}>{error}</div>}
        
        <form onSubmit={handleSubmit}>
          <div className="mb-3">
            <label className="form-label">Email</label>
            <input
              type="email"
              className="form-control"
              name="email"
              value={formData.email}
              onChange={handleChange}
              required
              autoFocus
            />
          </div>
          
          <div className="mb-3">
            <label className="form-label">Password</label>
            <input
              type="password"
              className="form-control"
              name="password"
              value={formData.password}
              onChange={handleChange}
              required
            />
          </div>
          
          <button 
            type="submit" 
            className="btn btn-primary w-100 mb-3"
            disabled={loading}
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
        
        <div className="auth-links">
          <button 
            type="button" 
            className="btn btn-link"
            onClick={onSwitchToRegister}
          >
            Don't have an account? Register
          </button>
          <button 
            type="button" 
            className="btn btn-link"
            onClick={onForgotPassword}
          >
            Forgot Password?
          </button>
        </div>
      </div>
    </div>
  );
};

export default Login;