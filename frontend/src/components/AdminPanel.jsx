import React, { useState, useEffect } from 'react';

const AdminPanel = ({ user }) => {
  const [pendingUsers, setPendingUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [activeTab, setActiveTab] = useState('pending');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (activeTab === 'pending') {
      fetchPendingUsers();
    } else {
      fetchAllUsers();
    }
  }, [activeTab]);

  const authenticatedFetch = (url, options = {}) => {
    const token = localStorage.getItem('authToken');
    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    });
  };

  const fetchPendingUsers = async () => {
    setLoading(true);
    try {
      const response = await authenticatedFetch('/api/admin/pending-users');
      if (response.ok) {
        const data = await response.json();
        setPendingUsers(data);
      } else {
        setMessage('Failed to fetch pending users');
      }
    } catch (error) {
      setMessage('Error fetching pending users');
    } finally {
      setLoading(false);
    }
  };

  const fetchAllUsers = async () => {
    setLoading(true);
    try {
      const response = await authenticatedFetch('/api/admin/users');
      if (response.ok) {
        const data = await response.json();
        setAllUsers(data);
      } else {
        setMessage('Failed to fetch users');
      }
    } catch (error) {
      setMessage('Error fetching users');
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (userId) => {
    try {
      const response = await authenticatedFetch('/api/admin/approve-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });

      if (response.ok) {
        const data = await response.json();
        setMessage(data.message);
        // Refresh the lists
        fetchPendingUsers();
        if (activeTab === 'all') fetchAllUsers();
      } else {
        const error = await response.json();
        setMessage(error.error || 'Failed to approve user');
      }
    } catch (error) {
      setMessage('Error approving user');
    }
  };

  const handleReject = async (userId) => {
    if (!confirm('Are you sure you want to reject this user?')) return;

    try {
      const response = await authenticatedFetch('/api/admin/reject-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });

      if (response.ok) {
        const data = await response.json();
        setMessage(data.message);
        // Refresh the lists
        fetchPendingUsers();
        if (activeTab === 'all') fetchAllUsers();
      } else {
        const error = await response.json();
        setMessage(error.error || 'Failed to reject user');
      }
    } catch (error) {
      setMessage('Error rejecting user');
    }
  };

  const handleToggleSuperUser = async (userId, currentStatus) => {
    const action = currentStatus ? 'remove-super-user' : 'make-super-user';
    const confirmMessage = currentStatus 
      ? 'Are you sure you want to remove super user status?' 
      : 'Are you sure you want to make this user a super user?';

    if (!confirm(confirmMessage)) return;

    try {
      const response = await authenticatedFetch(`/api/admin/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });

      if (response.ok) {
        const data = await response.json();
        setMessage(data.message);
        fetchAllUsers();
      } else {
        const error = await response.json();
        setMessage(error.error || 'Failed to update user');
      }
    } catch (error) {
      setMessage('Error updating user');
    }
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <div className="admin-panel">
      <div className="admin-header">
        <h2>
          <i className="fas fa-users-cog me-2"></i>
          User Administration
        </h2>
        <p className="text-muted">Manage user access and permissions</p>
      </div>

      {message && (
        <div className="alert alert-info alert-dismissible">
          {message}
          <button 
            type="button" 
            className="btn-close" 
            onClick={() => setMessage('')}
          ></button>
        </div>
      )}

      <div className="admin-tabs">
        <button 
          className={`admin-tab ${activeTab === 'pending' ? 'active' : ''}`}
          onClick={() => setActiveTab('pending')}
        >
          <i className="fas fa-clock me-1"></i>
          Pending Approvals
          {pendingUsers.length > 0 && (
            <span className="badge bg-warning ms-1">{pendingUsers.length}</span>
          )}
        </button>
        <button 
          className={`admin-tab ${activeTab === 'all' ? 'active' : ''}`}
          onClick={() => setActiveTab('all')}
        >
          <i className="fas fa-users me-1"></i>
          All Users
        </button>
      </div>

      <div className="admin-content">
        {loading ? (
          <div className="text-center p-4">
            <div className="spinner-border text-primary" role="status">
              <span className="visually-hidden">Loading...</span>
            </div>
          </div>
        ) : (
          <>
            {activeTab === 'pending' && (
              <div className="pending-users">
                {pendingUsers.length === 0 ? (
                  <div className="empty-state">
                    <i className="fas fa-check-circle text-success mb-3"></i>
                    <h5>No pending approvals</h5>
                    <p className="text-muted">All users have been processed</p>
                  </div>
                ) : (
                  <div className="users-list">
                    {pendingUsers.map(user => (
                      <div key={user.id} className="user-card pending">
                        <div className="user-info">
                          <div className="user-details">
                            <h6>{user.name || 'No name provided'}</h6>
                            <p className="user-email">{user.email}</p>
                            <small className="text-muted">
                              Registered: {formatDate(user.created_at)}
                            </small>
                          </div>
                        </div>
                        <div className="user-actions">
                          <button
                            className="btn btn-success btn-sm me-2"
                            onClick={() => handleApprove(user.id)}
                          >
                            <i className="fas fa-check me-1"></i>
                            Approve
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleReject(user.id)}
                          >
                            <i className="fas fa-times me-1"></i>
                            Reject
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'all' && (
              <div className="all-users">
                <div className="users-list">
                  {allUsers.map(user => (
                    <div key={user.id} className={`user-card ${user.status}`}>
                      <div className="user-info">
                        <div className="user-details">
                          <div className="user-name-row">
                            <h6>{user.name || 'No name provided'}</h6>
                            {user.is_super_user && (
                              <span className="badge bg-primary ms-2">
                                <i className="fas fa-crown me-1"></i>
                                Super User
                              </span>
                            )}
                            <span className={`badge ms-2 ${
                              user.status === 'approved' ? 'bg-success' : 
                              user.status === 'pending' ? 'bg-warning' : 'bg-danger'
                            }`}>
                              {user.status.charAt(0).toUpperCase() + user.status.slice(1)}
                            </span>
                          </div>
                          <p className="user-email">{user.email}</p>
                          <small className="text-muted">
                            Registered: {formatDate(user.created_at)}
                            {user.approved_at && (
                              <> • Approved: {formatDate(user.approved_at)}</>
                            )}
                            {user.approved_by && (
                              <> • By: {user.approved_by}</>
                            )}
                          </small>
                        </div>
                      </div>
                      <div className="user-actions">
                        {user.status === 'approved' && user.id !== user.userId && (
                          <button
                            className={`btn btn-sm ${user.is_super_user ? 'btn-outline-warning' : 'btn-outline-primary'}`}
                            onClick={() => handleToggleSuperUser(user.id, user.is_super_user)}
                          >
                            <i className={`fas ${user.is_super_user ? 'fa-user-minus' : 'fa-user-plus'} me-1`}></i>
                            {user.is_super_user ? 'Remove Super User' : 'Make Super User'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default AdminPanel;